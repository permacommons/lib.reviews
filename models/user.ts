import bcrypt from 'bcrypt';

import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import type { GetOptions, ModelInstance } from '../dal/lib/model-types.ts';
import type { ReportedErrorOptions } from '../util/abstract-reported-error.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import type { TeamInstance } from './manifests/team.ts';
import userManifest, {
  type CreateUserPayload,
  canonicalize,
  type UserAccessContext,
  type UserInstance,
  type UserInstanceMethods,
  type UserModel,
  type UserStaticMethods,
  type UserView,
  userOptions,
} from './manifests/user.ts';
import { referenceUserMeta, type UserMetaInstance } from './manifests/user-meta.ts';

const UserMeta = referenceUserMeta();

const BCRYPT_ROUNDS = 10; // matches legacy bcrypt-nodejs default cost

type FindByURLNameOptions = GetOptions & {
  withData?: boolean;
  withTeams?: boolean;
};

const userStatics = {
  options: userOptions,
} as const;

const userStaticMethods = defineStaticMethods(userManifest, {
  /**
   * Create a new user record from the supplied payload.
   *
   * @param userObj - User attributes to persist
   * @returns The created user instance
   * @throws NewUserError if validation fails or the user exists
   */
  async create(userObj: CreateUserPayload) {
    const user = new this({}) as UserInstance;

    if (!userObj || typeof userObj !== 'object') {
      throw new NewUserError({
        message: 'We need a user object containing the user data to create a new user.',
      });
    }

    try {
      user.setName(userObj.name);
      if (userObj.email) user.email = userObj.email;

      await this.ensureUnique(userObj.name);
      await user.setPassword(userObj.password);
      await user.save();
      updateUploadPermission(user);
    } catch (error) {
      if (error instanceof NewUserError) throw error;

      throw new NewUserError({
        payload: { user },
        parentError: error instanceof Error ? error : undefined,
      });
    }

    return user;
  },
  /**
   * Ensure no other user already claims the provided name.
   *
   * @param name - Username to verify
   * @returns True when the name is available
   * @throws NewUserError if a conflicting user is found
   */
  async ensureUnique(name: string) {
    if (typeof name !== 'string') throw new Error('Username to check must be a string.');

    const trimmed = name.trim();
    const existingUser = await this.filterWhere({
      canonicalName: canonicalize(trimmed),
    }).first();
    if (existingUser) {
      throw new NewUserError({
        message: 'A user named %s already exists.',
        userMessage: 'username exists',
        messageParams: [trimmed],
      });
    }
    return true;
  },
  /**
   * Retrieve a user and join their associated teams according to the options.
   *
   * @param id - User identifier to look up
   * @param options - Join options forwarded to the DAL
   * @returns The hydrated user instance or null if not found
   */
  async getWithTeams(id: string, options: GetOptions = {}) {
    const user = (await this.get(id, { teams: true, ...options })) as UserInstance | null;
    return user;
  },
  /**
   * Find a user by their decoded URL name, optionally including sensitive fields and teams.
   *
   * @param name - URL-decoded name to search for
   * @param options - Controls included associations and sensitive fields
   * @returns The matching user instance
   * @throws DocumentNotFound if the user cannot be located
   */
  async findByURLName(name: string, options: FindByURLNameOptions = {}) {
    const trimmed = name.trim().replace(/_/g, ' ');

    let query = this.filterWhere({ canonicalName: canonicalize(trimmed) });

    if (
      options.includeSensitive &&
      Array.isArray(options.includeSensitive) &&
      typeof query.includeSensitive === 'function'
    ) {
      query = query.includeSensitive(options.includeSensitive);
    }

    if (options.withData && typeof query.getJoin === 'function') {
      query = query.getJoin({ meta: true });
    }

    const user = (await query.first()) as UserInstance | null;
    if (!user) {
      const notFoundError = new DocumentNotFound('User not found');
      notFoundError.name = 'DocumentNotFoundError';
      throw notFoundError;
    }

    if (options.withTeams) {
      await _attachUserTeams(user);
    }

    updateUploadPermission(user);
    return user;
  },
  /**
   * Create or update the biography associated with a user and persist both entities.
   *
   * @param user - User instance that should receive the biography
   * @param bioObj - Object containing multilingual bio data
   * @returns The updated user instance
   */
  async createBio(user: UserInstance, bioObj: Pick<UserMetaInstance, 'bio' | 'originalLanguage'>) {
    const metaRev = await UserMeta.createFirstRevision(user, {
      tags: ['create-bio-via-user'],
    });

    metaRev.bio = bioObj.bio;
    metaRev.originalLanguage = bioObj.originalLanguage;

    await metaRev.save();

    user.userMetaID = metaRev.id as string;
    user.meta = metaRev;
    await user.save();
    return user;
  },
  canonicalize,
}) satisfies UserStaticMethods;

const userInstanceMethods = defineInstanceMethods(userManifest, {
  /**
   * Populate permission flags on this instance relative to the provided viewer.
   *
   * @param user - Viewer whose rights should be reflected on the instance
   */
  populateUserInfo(user: UserAccessContext | null | undefined) {
    if (!user) return;
    if (user.id === this.id) this.userCanEditMetadata = true;
  },
  /**
   * Update the user's display name and recompute derived identifiers without persisting.
   *
   * @param displayName - New display name to assign
   */
  setName(displayName: string) {
    if (typeof displayName !== 'string') throw new Error('Username to set must be a string.');

    const trimmed = displayName.trim();
    this.displayName = trimmed;
    this.canonicalName = canonicalize(trimmed);
    this.generateVirtualValues();
  },
  /**
   * Hash and set a user's password, enforcing the configured minimum length.
   *
   * @param password - Plain-text password to hash
   * @returns Promise resolving with the stored hash
   */
  setPassword(password: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof password !== 'string') {
        reject(new Error('Password must be a string.'));
        return;
      }

      if (password.length < userOptions.minPasswordLength) {
        reject(
          new NewUserError({
            message: 'Password for new user is too short, must be at least %s characters.',
            userMessage: 'password too short',
            messageParams: [String(userOptions.minPasswordLength)],
          })
        );
        return;
      }

      bcrypt.hash(password, BCRYPT_ROUNDS, (error, hash) => {
        if (error) {
          reject(error);
        } else {
          this.password = hash;
          resolve(this.password as string);
        }
      });
    });
  },
  /**
   * Compare a plain-text password against the stored hash.
   *
   * @param password - Password candidate to verify
   * @returns Promise resolving with true if the password matches
   */
  checkPassword(password: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, this.password as string, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  },
  /**
   * List the preference keys supported by the current API.
   *
   * @returns Array of preference names
   */
  getValidPreferences(): string[] {
    return ['prefersRichTextEditor'];
  },
}) satisfies UserInstanceMethods;

const User = defineModel(userManifest, {
  statics: userStatics,
  staticMethods: userStaticMethods,
  instanceMethods: userInstanceMethods,
}) as UserModel;

type NewUserErrorOptions = ReportedErrorOptions & {
  payload?: { user?: UserInstance };
  parentError?: Error;
};

/**
 * Update upload permissions on a user instance based on trust status.
 *
 * @param user - User instance to mutate
 */
function updateUploadPermission(user: UserInstance): void {
  user.userCanUploadTempFiles = Boolean(user.isTrusted || user.isSuperUser);
}

/**
 * Populate the user's team memberships and moderator assignments.
 *
 * @param user - User instance to enrich with team data
 */
async function _attachUserTeams(user: UserInstance): Promise<void> {
  user.teams = [];
  user.moderatorOf = [];

  if (typeof user.id !== 'string' || user.id.length === 0) {
    return;
  }

  try {
    const hydrated = await User.filterWhere({ id: user.id })
      .getJoin({ teams: true, moderatorOf: true })
      .first();

    if (hydrated) {
      user.teams = Array.isArray(hydrated.teams) ? (hydrated.teams as TeamInstance[]) : [];
      user.moderatorOf = Array.isArray(hydrated.moderatorOf)
        ? (hydrated.moderatorOf as TeamInstance[])
        : [];
    }
  } catch (error) {
    debug.error('Error attaching teams to user via relations');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
  }
}

/**
 * Batch-load the user public profile view for a set of identifiers.
 *
 * @param userIds - Collection of user IDs to hydrate via {@link UserView}
 * @returns Map of user IDs to their corresponding `UserView`
 */
async function fetchUserPublicProfiles(userIds: Iterable<string>): Promise<Map<string, UserView>> {
  const normalizedIds = [
    ...new Set(
      Array.from(userIds).filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];
  const userMap = new Map<string, UserView>();
  if (!normalizedIds.length) {
    return userMap;
  }

  const profiles = await User.fetchView<UserView>('publicProfile', {
    configure(builder) {
      builder.whereIn('id', normalizedIds, { cast: 'uuid[]' });
    },
  });

  profiles.forEach(profile => {
    if (profile.id) {
      userMap.set(profile.id, profile);
    }
  });

  return userMap;
}

/**
 * Error class for reporting user registration failures with translated
 * messages derived from DAL errors.
 */
class NewUserError extends ReportedError {
  constructor(options: NewUserErrorOptions = {}) {
    const normalized = { ...options } as NewUserErrorOptions;

    if (normalized.parentError instanceof Error && normalized.payload?.user) {
      switch (normalized.parentError.message) {
        case 'Must be a valid email address':
          normalized.userMessage = 'invalid email format';
          normalized.userMessageParams = [normalized.payload.user.email];
          break;
        case `displayName must be shorter than ${userOptions.maxChars} characters`:
          normalized.userMessage = 'username too long';
          normalized.userMessageParams = [String(userOptions.maxChars)];
          break;
        case `email must be shorter than ${userOptions.maxChars} characters`:
          normalized.userMessage = 'email too long';
          normalized.userMessageParams = [String(userOptions.maxChars)];
          break;
        default:
      }
    }

    super(normalized as ReportedErrorOptions);
  }
}

export { fetchUserPublicProfiles, NewUserError };

export type {
  CreateUserPayload,
  UserAccessContext,
  UserInstance,
  UserInstanceMethods,
  UserModel,
  UserStaticMethods,
  UserView,
} from './manifests/user.ts';
export {
  canonicalize,
  referenceUser,
  userOptions,
} from './manifests/user.ts';

export default User;
