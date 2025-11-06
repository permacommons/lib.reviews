import bcrypt from 'bcrypt';

import { DocumentNotFound } from '../dal/lib/errors.ts';
import { createModel } from '../dal/lib/create-model.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
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

const userManifest = {
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
    urlName: types.virtual().default(function (this: ModelInstance) {
      const displayName =
        typeof this.getValue === 'function' ? this.getValue('displayName') : this.displayName;
      return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
    }),
    userCanEditMetadata: types.virtual().default(false),
    userCanUploadTempFiles: types.virtual().default(function (this: ModelInstance) {
      const isTrusted =
        typeof this.getValue === 'function' ? this.getValue('isTrusted') : this.isTrusted;
      const isSuperUser =
        typeof this.getValue === 'function' ? this.getValue('isSuperUser') : this.isSuperUser;
      return Boolean(isTrusted || isSuperUser);
    }),
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
  staticMethods: {
    increaseInviteLinkCount,
    create: createUser,
    ensureUnique,
    getWithTeams,
    findByURLName,
    canonicalize,
    createBio,
  },
  instanceMethods: {
    populateUserInfo,
    setName,
    setPassword,
    checkPassword,
    getValidPreferences,
  },
} as const;

const User = createModel(userManifest, {
  staticProperties: {
    options: userOptions,
  },
}) as Record<string, any>;

type NewUserErrorOptions = ReportedErrorOptions & {
  payload?: Record<string, any>;
  parentError?: Error;
};

/**
 * Increase a user's invite link count and return the updated value.
 *
 * @param this - Bound user model constructor
 * @param id - Unique identifier of the user
 * @returns Updated invite count
 */
async function increaseInviteLinkCount(this: any, id: string): Promise<number> {
  const model = this as {
    dal: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ invite_link_count: number }> }> };
    tableName: string;
  };

  const query = `
    UPDATE ${model.tableName}
    SET invite_link_count = invite_link_count + 1
    WHERE id = $1
    RETURNING invite_link_count
  `;

  const result = await model.dal.query(query, [id]);
  if (!result.rows.length) throw new Error(`User with id ${id} not found`);

  return result.rows[0].invite_link_count;
}

/**
 * Create a new user record from the supplied payload, hashing the password
 * and validating uniqueness before persisting the record.
 *
 * @param this - Bound user model constructor
 * @param userObj - Plain object containing user attributes
 * @returns The created user instance
 * @throws NewUserError if validation fails or the user already exists
 */
async function createUser(this: any, userObj: Record<string, any>): Promise<Record<string, any>> {
  const user = new this({}) as Record<string, any>;

  if (!userObj || typeof userObj !== 'object') {
    throw new NewUserError({
      message: 'We need a user object containing the user data to create a new user.',
    });
  }

  try {
    user.setName(userObj.name);
    if (userObj.email) user.email = userObj.email;

    await (this as { ensureUnique(name: string): Promise<boolean> }).ensureUnique(userObj.name);
    await user.setPassword(userObj.password);
    await user.save?.();
    updateUploadPermission(user);
  } catch (error) {
    if (error instanceof NewUserError) throw error;

    throw new NewUserError({
      payload: { user },
      parentError: error instanceof Error ? error : undefined,
    });
  }

  return user;
}

/**
 * Throw if another user already exists with the provided name.
 *
 * @param this - Bound user model constructor
 * @param name - Username to check for uniqueness
 * @returns True if the name is available
 * @throws NewUserError if a conflicting user already exists
 */
async function ensureUnique(this: any, name: string): Promise<boolean> {
  if (typeof name !== 'string') throw new Error('Username to check must be a string.');

  const trimmed = name.trim();
  const model = this as {
    filter: (criteria: Record<string, unknown>) => {
      run: () => Promise<Record<string, any>[]>;
    };
  };

  const users = await model.filter({ canonicalName: canonicalize(trimmed) }).run();
  if (users.length) {
    throw new NewUserError({
      message: 'A user named %s already exists.',
      userMessage: 'username exists',
      messageParams: [trimmed],
    });
  }
  return true;
}

/**
 * Retrieve a user and join their associated teams according to the options.
 *
 * @param this - Bound user model constructor
 * @param id - User identifier to look up
 * @param options - Query options forwarded to the DAL
 * @returns The hydrated user instance or null if not found
 */
async function getWithTeams(
  this: any,
  id: string,
  options: Record<string, any> = {}
): Promise<Record<string, any> | null> {
  const model = this as {
    get: (userID: string, join?: Record<string, unknown>) => Promise<Record<string, any> | null>;
  };
  return model.get(id, { teams: true, ...options });
}

/**
 * Find a user by their decoded URL name, optionally including sensitive
 * fields, metadata, and team associations.
 *
 * @param this - Bound user model constructor
 * @param name - URL-decoded name to search for
 * @param options - Controls included associations and sensitive fields
 * @returns The matching user instance
 * @throws DocumentNotFound if the user cannot be located
 */
async function findByURLName(
  this: any,
  name: string,
  options: Record<string, any> = {}
): Promise<Record<string, any>> {
  const trimmed = name.trim().replace(/_/g, ' ');

  let query = (this as {
    filter: (criteria: Record<string, unknown>) => any;
  }).filter({ canonicalName: canonicalize(trimmed) });

  if (
    options.includeSensitive &&
    Array.isArray(options.includeSensitive) &&
    typeof query.includeSensitive === 'function'
  )
    query = query.includeSensitive(options.includeSensitive);

  if (options.withData && typeof query.getJoin === 'function')
    query = query.getJoin({ meta: true });

  const users = await query.run();
  if (users.length) {
    const user = users[0] as Record<string, any>;

    if (options.withTeams) await attachUserTeams(user);

    updateUploadPermission(user);
    return user;
  }

  const notFoundError = new DocumentNotFound('User not found');
  notFoundError.name = 'DocumentNotFoundError';
  throw notFoundError;
}

/**
 * Create or update the biography associated with a user and persist both
 * entities.
 *
 * @param this - Bound user model constructor
 * @param user - User instance that should receive the biography
 * @param bioObj - Object containing multilingual bio data
 * @returns The updated user instance
 */
async function createBio(
  this: any,
  user: Record<string, any>,
  bioObj: Record<string, any>
): Promise<Record<string, any>> {
  const metaRev = await (UserMeta as unknown as {
    createFirstRevision: (
      instance: Record<string, any>,
      options?: { tags?: string[]; date?: Date }
    ) => Promise<ModelInstance>;
  }).createFirstRevision(user, {
    tags: ['create-bio-via-user'],
  });

  metaRev.bio = bioObj.bio;
  metaRev.originalLanguage = bioObj.originalLanguage;

  await metaRev.save?.();

  user.userMetaID = metaRev.id as string;
  user.meta = metaRev;
  await user.save?.();
  return user;
}

/**
 * Populate the user's team memberships and moderator assignments.
 *
 * @param user - User instance to enrich with team data
 */
async function attachUserTeams(user: Record<string, any>): Promise<void> {
  user.teams = [];
  user.moderatorOf = [];

  const teamModel = Team as unknown as {
    dal: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>; schemaNamespace?: string };
    tableName: string;
    _createInstance?: (record: unknown) => ModelInstance;
  };
  const dalInstance = teamModel.dal;
  const teamTable = teamModel.tableName;
  const prefix = dalInstance.schemaNamespace || '';
  const memberTable = `${prefix}team_members`;
  const moderatorTable = `${prefix}team_moderators`;

  const currentRevisionFilter = `
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
  `;

  const mapRowsToTeams = (rows: any[]) =>
    rows.map(row =>
      teamModel._createInstance
        ? teamModel._createInstance(row)
        : new (Team as unknown as { new (...args: unknown[]): ModelInstance })(row)
    );

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
 * Populate permission flags on this user instance relative to the provided
 * viewer.
 *
 * @param user - Viewer whose rights should be reflected on the instance
 */
function populateUserInfo(this: Record<string, any>, user: Record<string, any> | null | undefined): void {
  if (!user) return;

  if (user.id === this.id) this.userCanEditMetadata = true;
}

/**
 * Update the user's display name and recompute derived identifiers without
 * persisting changes.
 *
 * @param displayName - New display name to assign
 */
function setName(this: Record<string, any>, displayName: string): void {
  if (typeof displayName !== 'string') throw new Error('Username to set must be a string.');

  const trimmed = displayName.trim();
  this.displayName = trimmed;
  this.canonicalName = canonicalize(trimmed);
  this.generateVirtualValues?.();
}

/**
 * Hash and set a user's password, enforcing minimum length requirements.
 *
 * @param password - Plain text password to hash
 * @returns Promise resolving to the stored password hash
 */
function setPassword(this: Record<string, any>, password: string): Promise<string> {
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
}

/**
 * Compare a plaintext password against the stored hash for this user.
 *
 * @param password - Plain text password to verify
 * @returns Promise resolving with true if the password matches
 */
function checkPassword(this: Record<string, any>, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, this.password as string, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/**
 * List the preference keys that the current API supports toggling.
 *
 * @returns Array of preference names
 */
function getValidPreferences(): string[] {
  return ['prefersRichTextEditor'];
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

export default User;
export { NewUserError };
