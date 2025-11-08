import bcrypt from 'bcrypt';

import { DocumentNotFound } from '../dal/lib/errors.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import types from '../dal/lib/type.ts';
import type { ReportedErrorOptions } from '../util/abstract-reported-error.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import Team from './team.ts';
import UserMeta from './user-meta.ts';

const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6,
  illegalCharsReadable: '',
};

const BCRYPT_ROUNDS = 10; // matches legacy bcrypt-nodejs default cost

// Erm, if we add [, ] or \ to forbidden chars, we'll have to fix this :)
userOptions.illegalCharsReadable = userOptions.illegalChars.source.replace(/[\[\]\\]/g, '');

const userManifest = defineModelManifest({
  tableName: 'users',
  hasRevisions: false,
  schema: {
    id: types.string().uuid(4),
    displayName: types
      .string()
      .max(userOptions.maxChars)
      .validator(containsOnlyLegalCharacters)
      .required(),
    canonicalName: types
      .string()
      .max(userOptions.maxChars)
      .validator(containsOnlyLegalCharacters)
      .required(),
    email: types.string().max(userOptions.maxChars).email().sensitive(),
    password: types.string().sensitive(),
    userMetaID: types.string().uuid(4),
    inviteLinkCount: types.number().integer().default(0),
    registrationDate: types.date().default(() => new Date()),
    showErrorDetails: types.boolean().default(false),
    isTrusted: types.boolean().default(false),
    isSiteModerator: types.boolean().default(false),
    isSuperUser: types.boolean().default(false),
    suppressedNotices: types.array(types.string()),
    prefersRichTextEditor: types.boolean().default(false),
    urlName: types
      .virtual()
      .returns<string | undefined>()
      .default(function (this: ModelInstance) {
        const displayName =
          typeof this.getValue === 'function' ? this.getValue('displayName') : this.displayName;
        return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
      }),
    userCanEditMetadata: types.virtual().returns<boolean>().default(false),
    userCanUploadTempFiles: types
      .virtual()
      .returns<boolean>()
      .default(function (this: ModelInstance) {
        const isTrusted =
          typeof this.getValue === 'function' ? this.getValue('isTrusted') : this.isTrusted;
        const isSuperUser =
          typeof this.getValue === 'function' ? this.getValue('isSuperUser') : this.isSuperUser;
        return Boolean(isTrusted || isSuperUser);
      }),
    meta: types.virtual().returns<ModelInstance | undefined>().default(undefined),
    teams: types.virtual().returns<ModelInstance[] | undefined>().default(undefined),
    moderatorOf: types.virtual().returns<ModelInstance[] | undefined>().default(undefined),
  },
  camelToSnake: {
    displayName: 'display_name',
    canonicalName: 'canonical_name',
    userMetaID: 'user_meta_id',
    inviteLinkCount: 'invite_link_count',
    registrationDate: 'registration_date',
    showErrorDetails: 'show_error_details',
    isTrusted: 'is_trusted',
    isSiteModerator: 'is_site_moderator',
    isSuperUser: 'is_super_user',
    suppressedNotices: 'suppressed_notices',
    prefersRichTextEditor: 'prefers_rich_text_editor',
  },
  relations: [
    {
      name: 'teams',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'team_members',
        sourceForeignKey: 'user_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
    {
      name: 'moderatorOf',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'team_moderators',
        sourceForeignKey: 'user_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
    {
      name: 'meta',
      targetTable: 'user_metas',
      sourceKey: 'user_meta_id',
      targetKey: 'id',
      hasRevisions: true,
      cardinality: 'one',
    },
  ] as const,
  instanceMethods: {
    /**
     * Populate permission flags on this instance relative to the provided viewer.
     *
     * @param user - Viewer whose rights should be reflected on the instance
     */
    populateUserInfo(user: UserViewer | null | undefined) {
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
  },
  staticMethods: {
    /**
     * Increase a user's invite link count and return the new total.
     *
     * @param id - Identifier of the user to update
     * @returns The updated invite count
     */
    async increaseInviteLinkCount(id: string) {
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
    async create(userObj: Record<string, any>) {
      const user = new this({});

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
      const users = await this.filter({ canonicalName: canonicalize(trimmed) }).run();
      if (users.length) {
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
    async getWithTeams(id: string, options: Record<string, any> = {}) {
      const user = await this.get(id, { teams: true, ...options });
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
    async findByURLName(name: string, options: Record<string, any> = {}) {
      const trimmed = name.trim().replace(/_/g, ' ');

      let query = this.filter({ canonicalName: canonicalize(trimmed) });

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

      const users = await query.run();
      if (users.length) {
        const user = users[0] as InferInstance<typeof userManifest>;

        if (options.withTeams) await _attachUserTeams(user);

        updateUploadPermission(user);
        return user;
      }

      const notFoundError = new DocumentNotFound('User not found');
      notFoundError.name = 'DocumentNotFoundError';
      throw notFoundError;
    },
    /**
     * Create or update the biography associated with a user and persist both entities.
     *
     * @param user - User instance that should receive the biography
     * @param bioObj - Object containing multilingual bio data
     * @returns The updated user instance
     */
    async createBio(user: InferInstance<typeof userManifest>, bioObj: Record<string, any>) {
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
  },
} as const);

const User = defineModel(userManifest, {
  statics: {
    options: userOptions,
  },
});

export type UserInstance = InferInstance<typeof userManifest>;
export type UserViewer = {
  id: UserInstance['id'];
  isSuperUser?: UserInstance['isSuperUser'];
  isSiteModerator?: UserInstance['isSiteModerator'];
  isTrusted?: UserInstance['isTrusted'];
};
export type UserModel = InferConstructor<typeof userManifest>;

export default User;

type NewUserErrorOptions = ReportedErrorOptions & {
  payload?: Record<string, any>;
  parentError?: Error;
};

/**
 * Normalize a username to its canonical uppercase form.
 *
 * @param name - Username to canonicalize
 * @returns Uppercase representation used for lookups
 */
function canonicalize(name: string): string {
  return name.toUpperCase();
}

/**
 * Validate that the supplied username avoids characters disallowed by the
 * registration rules.
 *
 * @param name - Username to validate
 * @returns True when the name passes validation
 * @throws NewUserError if illegal characters are detected
 */
function containsOnlyLegalCharacters(name: string): true {
  if (userOptions.illegalChars.test(name)) {
    throw new NewUserError({
      message: 'Username %s contains invalid characters.',
      messageParams: [name],
      userMessage: 'invalid username characters',
      userMessageParams: [userOptions.illegalCharsReadable],
    });
  }
  return true;
}

/**
 * Update upload permissions on a user instance based on trust status.
 *
 * @param user - User instance to mutate
 */
function updateUploadPermission(user: ModelInstance): void {
  user.userCanUploadTempFiles = Boolean(user.isTrusted || user.isSuperUser);
}


/**
 * Populate the user's team memberships and moderator assignments.
 *
 * @param user - User instance to enrich with team data
 */
async function _attachUserTeams(user: InferInstance<typeof userManifest>): Promise<void> {
  user.teams = [];
  user.moderatorOf = [];

  const dalInstance = Team.dal;
  const teamTable = Team.tableName;
  const prefix = dalInstance.schemaNamespace || '';
  const memberTable = `${prefix}team_members`;
  const moderatorTable = `${prefix}team_moderators`;

  const currentRevisionFilter = `
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
  `;

  const mapRowsToTeams = (rows: any[]) =>
    rows.map(row => Team.createFromRow(row as Record<string, unknown>));

  try {
    const memberResult = await dalInstance.query(
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
    const moderatorResult = await dalInstance.query(
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
