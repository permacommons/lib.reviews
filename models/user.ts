import bcrypt from 'bcrypt';

import dal from '../dal/index.js';
import { DocumentNotFound } from '../dal/lib/errors.js';
import { createModelModule } from '../dal/lib/model-handle.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.js';
import debug from '../util/debug.js';
import ReportedError from '../util/reported-error.js';
import type { ReportedErrorOptions } from '../util/abstract-reported-error.js';
import Team from './team.js';
import UserMeta from './user-meta.js';

type PostgresModule = typeof import('../db-postgres.js');

type UserRecord = JsonObject;
type UserVirtual = JsonObject;
type UserInstance = ModelInstance<UserRecord, UserVirtual> & Record<string, any>;
type UserModel = ModelConstructor<UserRecord, UserVirtual, UserInstance> & Record<string, any>;
type NewUserErrorOptions = ReportedErrorOptions & { payload?: Record<string, any>; parentError?: Error };

const { proxy: userHandleProxy, register: registerUserHandle } = createModelModule<UserRecord, UserVirtual, UserInstance>({
  tableName: 'users'
});

const UserHandle = userHandleProxy as UserModel;
const { types } = dal as unknown as { types: Record<string, any> };

const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6,
  illegalCharsReadable: ''
};

const BCRYPT_ROUNDS = 10; // matches legacy bcrypt-nodejs default cost

/* eslint-disable no-useless-escape */
// Erm, if we add [, ] or \ to forbidden chars, we'll have to fix this :)
userOptions.illegalCharsReadable = userOptions.illegalChars.source.replace(/[\[\]\\]/g, '');
/* eslint-enable no-useless-escape */

let User: UserModel | null = null;
let postgresModulePromise: Promise<PostgresModule> | null = null;

async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise)
    postgresModulePromise = import('../db-postgres.js');

  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

/**
 * Initialize the PostgreSQL User model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if the DAL is unavailable
 */
export async function initializeUserModel(dalInstance: Record<string, any> | null = null): Promise<UserModel | null> {
  try {
    debug.db('Starting User model initialization...');
    const activeDAL = dalInstance ?? await getPostgresDAL();

    if (!activeDAL) {
      debug.db('PostgreSQL DAL not available, skipping User model initialization');
      return null;
    }

    debug.db('DAL available, creating User model...');
    const userSchema = {
      id: types.string().uuid(4),
      displayName: types.string().max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
      canonicalName: types.string().max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
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
      urlName: types.virtual().default(function (this: UserInstance) {
        const displayName = typeof this.getValue === 'function' ? this.getValue('displayName') : this.displayName;
        return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
      }),
      userCanEditMetadata: types.virtual().default(false),
      userCanUploadTempFiles: types.virtual().default(function (this: UserInstance) {
        const isTrusted = typeof this.getValue === 'function' ? this.getValue('isTrusted') : this.isTrusted;
        const isSuperUser = typeof this.getValue === 'function' ? this.getValue('isSuperUser') : this.isSuperUser;
        return Boolean(isTrusted || isSuperUser);
      })
    } as JsonObject;

    const { model, isNew } = initializeModel<UserRecord, UserVirtual, UserInstance>({
      dal: activeDAL as any,
      baseTable: 'users',
      schema: userSchema,
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
        prefersRichTextEditor: 'prefers_rich_text_editor'
      },
      staticMethods: {
        increaseInviteLinkCount,
        create: createUser,
        ensureUnique,
        getWithTeams,
        findByURLName,
        canonicalize,
        createBio
      },
      instanceMethods: {
        populateUserInfo,
        setName,
        setPassword,
        checkPassword,
        getValidPreferences
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
            targetForeignKey: 'team_id'
          },
          cardinality: 'many'
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
            targetForeignKey: 'team_id'
          },
          cardinality: 'many'
        },
        {
          name: 'meta',
          targetTable: 'user_metas',
          sourceKey: 'user_meta_id',
          targetKey: 'id',
          hasRevisions: true,
          cardinality: 'one'
        }
      ] as any
    });

    User = model as UserModel;

    if (!isNew)
      return User;

    Object.defineProperty(User, 'options', {
      value: userOptions,
      writable: false,
      enumerable: true,
      configurable: false
    });

    const prototype = User.prototype as UserInstance & { _validate(): unknown; _originalValidate?: () => unknown; _isNew: boolean };
    prototype._originalValidate = prototype._validate;
    prototype._validate = function (this: typeof prototype) {
      if (this._isNew && (!this.password || typeof this.password !== 'string'))
        throw new Error('Password must be set to a non-empty string.');

      return this._originalValidate ? this._originalValidate.call(this) : undefined;
    } as typeof prototype._validate;

    debug.db('PostgreSQL User model initialized with all methods');
    return User;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL User model');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

/**
 * Increase a user's invite link count and return the updated value.
 *
 * @param id - Unique identifier of the user
 * @returns Updated invite count
 */
async function increaseInviteLinkCount(id: string): Promise<number> {
  const model = (User ?? UserHandle) as UserModel;
  const query = `
    UPDATE ${model.tableName}
    SET invite_link_count = invite_link_count + 1
    WHERE id = $1
    RETURNING invite_link_count
  `;

  const result = await model.dal.query(query, [id]);
  if (!result.rows.length)
    throw new Error(`User with id ${id} not found`);

  return result.rows[0].invite_link_count;
}

/**
 * Create a new user record from the supplied payload, hashing the password
 * and validating uniqueness before persisting the record.
 *
 * @param userObj - Plain object containing user attributes
 * @returns The created user instance
 * @throws NewUserError if validation fails or the user already exists
 */
async function createUser(userObj: Record<string, any>): Promise<UserInstance> {
  const model = (User ?? UserHandle) as UserModel;
  const user = new model({});

  if (!userObj || typeof userObj !== 'object') {
    throw new NewUserError({
      message: 'We need a user object containing the user data to create a new user.'
    });
  }

  try {
    user.setName(userObj.name);
    if (userObj.email)
      user.email = userObj.email;

    await model.ensureUnique(userObj.name);
    await user.setPassword(userObj.password);
    await user.save();
    updateUploadPermission(user);
  } catch (error) {
    if (error instanceof NewUserError)
      throw error;

    throw new NewUserError({ payload: { user }, parentError: error instanceof Error ? error : undefined });
  }

  return user;
}

/**
 * Throw if another user already exists with the provided name.
 *
 * @param name - Username to check for uniqueness
 * @returns True if the name is available
 * @throws NewUserError if a conflicting user already exists
 */
async function ensureUnique(name: string): Promise<boolean> {
  if (typeof name !== 'string')
    throw new Error('Username to check must be a string.');

  const trimmed = name.trim();
  const users = await UserHandle.filter({ canonicalName: canonicalize(trimmed) }).run();
  if (users.length) {
    throw new NewUserError({
      message: 'A user named %s already exists.',
      userMessage: 'username exists',
      messageParams: [trimmed]
    });
  }
  return true;
}

/**
 * Retrieve a user and join their associated teams according to the options.
 *
 * @param id - User identifier to look up
 * @param options - Query options forwarded to the DAL
 * @returns The hydrated user instance or null if not found
 */
async function getWithTeams(id: string, options: Record<string, any> = {}): Promise<UserInstance | null> {
  return UserHandle.get(id, {
    teams: true,
    ...options
  }) as Promise<UserInstance | null>;
}

/**
 * Find a user by their decoded URL name, optionally including sensitive
 * fields, metadata, and team associations.
 *
 * @param name - URL-decoded name to search for
 * @param options - Controls included associations and sensitive fields
 * @returns The matching user instance
 * @throws DocumentNotFound if the user cannot be located
 */
async function findByURLName(name: string, options: Record<string, any> = {}): Promise<UserInstance> {
  const model = (User ?? UserHandle) as UserModel;
  const trimmed = name.trim().replace(/_/g, ' ');

  let query = model.filter({ canonicalName: canonicalize(trimmed) });

  if (options.includeSensitive && Array.isArray(options.includeSensitive) && typeof query.includeSensitive === 'function')
    query = query.includeSensitive(options.includeSensitive);

  if (options.withData && typeof query.getJoin === 'function')
    query = query.getJoin({ meta: true });

  const users = await query.run();
  if (users.length) {
    const user = users[0] as UserInstance;

    if (options.withTeams)
      await attachUserTeams(user);

    updateUploadPermission(user);
    return user;
  }

  const notFoundError = new DocumentNotFound('User not found');
  notFoundError.name = 'DocumentNotFoundError';
  throw notFoundError;
}

/**
 * Transform a user name into its canonical uppercase representation for
 * duplicate checks.
 *
 * @param name - Name to canonicalize
 * @returns Uppercase representation used for lookups
 */
function canonicalize(name: string): string {
  return name.toUpperCase();
}

/**
 * Create or update the biography associated with a user and persist both
 * entities.
 *
 * @param user - User instance that should receive the biography
 * @param bioObj - Object containing multilingual bio data
 * @returns The updated user instance
 */
async function createBio(user: UserInstance, bioObj: Record<string, any>): Promise<UserInstance> {
  const metaRev = await (UserMeta as any).createFirstRevision(user, {
    tags: ['create-bio-via-user']
  });

  metaRev.bio = bioObj.bio;
  metaRev.originalLanguage = bioObj.originalLanguage;

  await metaRev.save();

  user.userMetaID = metaRev.id;
  user.meta = metaRev;
  await user.save();
  return user;
}

/**
 * Populate the user's team memberships and moderator assignments.
 *
 * @param user - User instance to enrich with team data
 */
async function attachUserTeams(user: UserInstance): Promise<void> {
  user.teams = [];
  user.moderatorOf = [];

  const teamModel = Team as UserModel;
  const dalInstance = teamModel.dal;
  const teamTable = teamModel.tableName;
  const prefix = dalInstance.schemaNamespace || '';
  const memberTable = `${prefix}team_members`;
  const moderatorTable = `${prefix}team_moderators`;

  const currentRevisionFilter = `
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
  `;

  const mapRowsToTeams = (rows: any[]) => rows.map(row => teamModel._createInstance ? teamModel._createInstance(row) : new (Team as any)(row));

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
function populateUserInfo(this: UserInstance, user: UserInstance | null | undefined): void {
  if (!user)
    return;

  if (user.id === this.id)
    this.userCanEditMetadata = true;
}

/**
 * Update the user's display name and recompute derived identifiers without
 * persisting changes.
 *
 * @param displayName - New display name to assign
 */
function setName(this: UserInstance, displayName: string): void {
  if (typeof displayName !== 'string')
    throw new Error('Username to set must be a string.');

  const trimmed = displayName.trim();
  this.displayName = trimmed;
  this.canonicalName = canonicalize(trimmed);
  this.generateVirtualValues();
}

/**
 * Hash and set a user's password, enforcing minimum length requirements.
 *
 * @param password - Plain text password to hash
 * @returns Promise resolving to the stored password hash
 */
function setPassword(this: UserInstance, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof password !== 'string') {
      reject(new Error('Password must be a string.'));
      return;
    }

    if (password.length < userOptions.minPasswordLength) {
      reject(new NewUserError({
        message: 'Password for new user is too short, must be at least %s characters.',
        userMessage: 'password too short',
        messageParams: [String(userOptions.minPasswordLength)]
      }));
      return;
    }

    bcrypt.hash(password, BCRYPT_ROUNDS, (error, hash) => {
      if (error) {
        reject(error);
      } else {
        this.password = hash;
        resolve(this.password);
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
function checkPassword(this: UserInstance, password: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, this.password, (error, result) => {
      if (error)
        reject(error);
      else
        resolve(result);
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
 * Validate that the supplied username avoids characters disallowed by the
 * registration rules.
 *
 * @param name - Username to validate
 * @returns True when the name passes validation
 * @throws NewUserError if illegal characters are detected
 */
function _containsOnlyLegalCharacters(name: string): true {
  if (userOptions.illegalChars.test(name)) {
    throw new NewUserError({
      message: 'Username %s contains invalid characters.',
      messageParams: [name],
      userMessage: 'invalid username characters',
      userMessageParams: [userOptions.illegalCharsReadable]
    });
  }
  return true;
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

function updateUploadPermission(user: UserInstance): void {
  user.userCanUploadTempFiles = Boolean(user.isTrusted || user.isSuperUser);
}

registerUserHandle({
  initializeModel: initializeUserModel,
  handleOptions: {
    staticProperties: {
      options: userOptions
    }
  },
  additionalExports: {
    initializeUserModel,
    NewUserError
  }
});

export default UserHandle;
export { initializeUserModel as initializeModel, NewUserError };
