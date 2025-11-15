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
import { referenceTeam } from './manifests/team.ts';
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

const Team = referenceTeam();
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
   * Increase a user's invite link count and return the new total.
   *
   * @param id - Identifier of the user to update
   * @returns The updated invite count
   */
  async increaseInviteLinkCount(this: UserModel, id: string) {
    const query = `
        UPDATE ${this.tableName ?? 'users'}
        SET invite_link_count = invite_link_count + 1
        WHERE id = $1
        RETURNING invite_link_count
      `;

    const result = await this.dal.query(query, [id]);
    if (!result.rows.length) throw new Error(`User with id ${id} not found`);

    return (result.rows[0] as { invite_link_count: number }).invite_link_count;
  },
  /**
   * Create a new user record from the supplied payload.
   *
   * @param userObj - User attributes to persist
   * @returns The created user instance
   * @throws NewUserError if validation fails or the user exists
   */
  async create(this: UserModel, userObj: CreateUserPayload) {
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
  async ensureUnique(this: UserModel, name: string) {
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
  async getWithTeams(this: UserModel, id: string, options: GetOptions = {}) {
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
  async findByURLName(this: UserModel, name: string, options: FindByURLNameOptions = {}) {
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
  async createBio(
    this: UserModel,
    user: UserInstance,
    bioObj: Pick<UserMetaInstance, 'bio' | 'originalLanguage'>
  ) {
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
  populateUserInfo(this: UserInstance, user: UserAccessContext | null | undefined) {
    if (!user) return;
    if (user.id === this.id) this.userCanEditMetadata = true;
  },
  /**
   * Update the user's display name and recompute derived identifiers without persisting.
   *
   * @param displayName - New display name to assign
   */
  setName(this: UserInstance, displayName: string) {
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
  setPassword(this: UserInstance, password: string): Promise<string> {
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
  checkPassword(this: UserInstance, password: string): Promise<boolean> {
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
  getValidPreferences(this: UserInstance): string[] {
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

  const teamDal = Team.dal;
  const teamTable = Team.tableName;
  const createFromRow = Team.createFromRow;
  const dalInstance = teamDal;
  const prefix = dalInstance.schemaNamespace || '';
  const memberTable = `${prefix}team_members`;
  const moderatorTable = `${prefix}team_moderators`;

  const currentRevisionFilter = `
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
  `;

  const mapRowsToTeams = (rows: Array<Record<string, unknown>>) =>
    rows.map(row => createFromRow(row));

  try {
    const memberResult = await dalInstance.query<Record<string, unknown>>(
      `
        SELECT t.*
        FROM ${teamTable} t
        JOIN ${memberTable} tm ON t.id = tm.team_id
        WHERE tm.user_id = $1
        ${currentRevisionFilter}
      `,
      [user.id]
    );
    user.teams = mapRowsToTeams(memberResult.rows);
  } catch (error) {
    debug.error('Error attaching team memberships to user');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
  }

  try {
    const moderatorResult = await dalInstance.query<Record<string, unknown>>(
      `
        SELECT t.*
        FROM ${teamTable} t
        JOIN ${moderatorTable} tm ON t.id = tm.team_id
        WHERE tm.user_id = $1
        ${currentRevisionFilter}
      `,
      [user.id]
    );
    user.moderatorOf = mapRowsToTeams(moderatorResult.rows);
  } catch (error) {
    debug.error('Error attaching moderation teams to user');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
  }
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

export { NewUserError };

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
  containsOnlyLegalCharacters,
  referenceUser,
  userOptions,
} from './manifests/user.ts';

export default User;
