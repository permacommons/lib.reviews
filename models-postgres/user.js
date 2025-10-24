'use strict';

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const bcrypt = require('bcrypt');
const ReportedError = require('../util/reported-error');
const debug = require('../util/debug');
const { getPostgresUserMetaModel } = require('./user-meta');
const { DocumentNotFound } = require('../dal/lib/errors');
const { initializeModel } = require('../dal/lib/model-initializer');

const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6
};
const BCRYPT_ROUNDS = 10; // matches legacy bcrypt-nodejs default cost

/* eslint-disable no-useless-escape */ // False positive
// Erm, if we add [, ] or \ to forbidden chars, we'll have to fix this :)
userOptions.illegalCharsReadable = userOptions.illegalChars.source.replace(/[\[\]\\]/g, '');
/* eslint-enable no-useless-escape */

let User = null;
let currentDAL = null;

/**
 * Initialize the PostgreSQL User model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeUserModel(dal = null) {
  try {
    debug.db('Starting User model initialization...');
    const activeDAL = dal || await getPostgresDAL();

    if (!activeDAL) {
      debug.db('PostgreSQL DAL not available, skipping User model initialization');
      return null;
    }

    currentDAL = activeDAL;

    debug.db('DAL available, creating User model...');
    const userSchema = {
      id: type.string().uuid(4),
      
      // CamelCase schema fields that map to snake_case database columns
      displayName: type.string()
        .max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
      canonicalName: type.string()
        .max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
      email: type.string().max(userOptions.maxChars).email(),
      password: type.string(),
      userMetaID: type.string().uuid(4),
      inviteLinkCount: type.number().integer().default(0),
      registrationDate: type.date().default(() => new Date()),
      showErrorDetails: type.boolean().default(false),
      isTrusted: type.boolean().default(false),
      isSiteModerator: type.boolean().default(false),
      isSuperUser: type.boolean().default(false),
      suppressedNotices: type.array(type.string()),
      prefersRichTextEditor: type.boolean().default(false),
      
      // Virtual fields for compatibility
      urlName: type.virtual().default(function() {
        const displayName = this.getValue ? this.getValue('displayName') : this.displayName;
        return displayName ? encodeURIComponent(displayName.replace(/ /g, '_')) : undefined;
      }),
      userCanEditMetadata: type.virtual().default(false),
      userCanUploadTempFiles: type.virtual().default(function() {
        const isTrusted = this.getValue ? this.getValue('isTrusted') : this.isTrusted;
        const isSuperUser = this.getValue ? this.getValue('isSuperUser') : this.isSuperUser;
        return isTrusted || isSuperUser;
      })
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
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
      ]
    });

    User = model;

    if (!isNew) {
      return User;
    }

    Object.defineProperty(User, 'options', {
      value: userOptions,
      writable: false,
      enumerable: true,
      configurable: false
    });

    // Pre-save validation
    User.prototype._originalValidate = User.prototype._validate;
    User.prototype._validate = function() {
      if (!this.password || typeof this.password != 'string') {
        throw new Error('Password must be set to a non-empty string.');
      }
      return this._originalValidate();
    };

    debug.db('PostgreSQL User model initialized with all methods');
    return User;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL User model:', error);

    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Increase the invite link count by 1 for a given user
 *
 * @param {String} id - unique ID of the user
 * @returns {Number} updated invite count
 * @async
 */
async function increaseInviteLinkCount(id) {
  const query = `
    UPDATE ${User.tableName} 
    SET invite_link_count = invite_link_count + 1 
    WHERE id = $1 
    RETURNING invite_link_count
  `;
  
  const result = await User.dal.query(query, [id]);
  if (result.rows.length === 0) {
    throw new Error(`User with id ${id} not found`);
  }
  
  return result.rows[0].invite_link_count;
}

/**
 * Create a new user from an object containing the user data. Hashes the
 * password, checks for uniqueness, validates. Saves.
 *
 * @param {Object} userObj - plain object containing data supported by this model
 * @returns {User} the created user
 * @throws {NewUserError} if user exists, password is too short, or there are other validation problems.
 * @async
 */
async function createUser(userObj) {
  const user = new User({});
  if (typeof userObj != 'object') {
    throw new NewUserError({
      message: 'We need a user object containing the user data to create a new user.',
    });
  }

  try {
    user.setName(userObj.name);
    // we have to check, because assigning an empty string would trigger the
    // validation to kick in
    if (userObj.email) {
      user.email = userObj.email;
    }
    await User.ensureUnique(userObj.name); // throws if exists
    await user.setPassword(userObj.password); // throws if too short
    await user.save();
  } catch (error) {
    throw error instanceof NewUserError ?
      error :
      new NewUserError({ payload: { user }, parentError: error });
  }
  return user;
}

/**
 * Throw if we already have a user with this name.
 *
 * @param {String} name - username to check
 * @returns {Boolean} true if unique
 * @throws {NewUserError} if exists
 * @async
 */
async function ensureUnique(name) {
  if (typeof name != 'string') {
    throw new Error('Username to check must be a string.');
  }

  name = name.trim();
  const users = await User.filter({ canonicalName: User.canonicalize(name) }).run();
  if (users.length) {
    throw new NewUserError({
      message: 'A user named %s already exists.',
      userMessage: 'username exists',
      messageParams: [name]
    });
  }
  return true;
}

/**
 * Obtain user and all associated teams
 *
 * @param {String} id - user ID to look up
 * @returns {Promise<User>} user with associated teams
 */
async function getWithTeams(id) {
  return User.get(id, {
    teams: true
  });
}

/**
 * Find a user by the urldecoded URL name (spaces replaced with underscores)
 *
 * @param {String} name - decoded URL name
 * @param {Object} [options] - query criteria
 * @param {Boolean} options.withPassword=false - if false, password will be filtered from result
 * @param {Boolean} options.withData=false - if true, the associated user-metadata object will be joined
 * @param {Boolean} options.withTeams=false - if true, the associated teams will be joined
 * @returns {User} the matching user object
 * @throws {Error} if not found
 * @async
 */
async function findByURLName(name, {
  withPassword = false,
  withData = false,
  withTeams = false
} = {}) {

  name = name.trim().replace(/_/g, ' ');

  let query = User.filter({ canonicalName: User.canonicalize(name) });

  const users = await query.run();
  if (users.length) {
    const user = users[0];

    if (withData) {
      await attachUserMeta(user);
    }

    if (withTeams) {
      await attachUserTeams(user);
    }

    if (!withPassword) {
      // Remove password from result
      delete user._data.password;
    }

    return user;
  }

  const notFoundError = new DocumentNotFound('User not found');
  // Maintain legacy Thinky error name for compatibility with existing handlers
  notFoundError.name = 'DocumentNotFoundError';
  throw notFoundError;
}

/**
 * Transform a user name to its canonical internal form (upper case), used for
 * duplicate checking.
 *
 * @param {String} name - name to transform
 * @returns {String} canonical form
 */
function canonicalize(name) {
  return name.toUpperCase();
}

/**
 * Associate a new bio text with a given user and save both
 *
 * @param {User} user - user object to associate the bio with
 * @param {Object} bioObj - plain object with data conforming to UserMeta schema
 * @returns {User} updated user
 * @async
 */
async function createBio(user, bioObj) {
  const { getModel } = require('../bootstrap/dal');
  const UserMeta = getModel('user_metas');
  if (!UserMeta) {
    throw new Error('UserMeta model not available');
  }

  const metaRev = await UserMeta.createFirstRevision(user, {
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
 * Attach the associated UserMeta record to the given user instance
 *
 * @param {User} user - user instance to enrich with metadata
 * @returns {Promise<void>}
 * @async
 */
async function attachUserMeta(user) {
  if (!user || !user.userMetaID) {
    user.meta = undefined;
    return;
  }

  const { getModel } = require('../bootstrap/dal');
  const UserMeta = getModel('user_metas');
  if (!UserMeta) {
    user.meta = undefined;
    return;
  }

  try {
    const meta = await UserMeta.getNotStaleOrDeleted(user.userMetaID);
    user.meta = meta;
  } catch (error) {
    if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError') {
      user.meta = undefined;
    } else {
      throw error;
    }
  }
}

/**
 * Attach team membership and moderator data to the user instance
 *
 * @param {User} user - user instance to enrich with team data
 * @returns {Promise<void>}
 * @async
 */
async function attachUserTeams(user) {
  user.teams = [];
  user.moderatorOf = [];

  const { getModel } = require('../bootstrap/dal');
  const Team = getModel('teams');
  if (!Team) {
    return;
  }

  const dal = Team.dal;
  const teamTable = Team.tableName;
  const prefix = dal.tablePrefix || '';
  const memberTable = `${prefix}team_members`;
  const moderatorTable = `${prefix}team_moderators`;

  const currentRevisionFilter = `
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
  `;

  const mapRowsToTeams = rows => rows.map(row => Team._createInstance(row));

  try {
    const memberResult = await dal.query(
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
    debug.error('Error attaching team memberships to user:', error);
  }

  try {
    const moderatorResult = await dal.query(
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
    debug.error('Error attaching moderation teams to user:', error);
  }
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Determine what the provided user (typically the currently logged in user)
 * may do with the data associated with this User object, and populate its
 * permission fields accordingly.
 *
 * @param {User} user - user whose permissions on this User object we want to determine
 * @memberof User
 * @instance
 */
function populateUserInfo(user) {
  if (!user) {
    return; // Permissions at default (false)
  }

  // For now, only the user may edit metadata like bio.
  // In future, translators may also be able to.
  if (user.id == this.id) {
    this.userCanEditMetadata = true;
  }
}

/**
 * Updates display name, canonical name (used for duplicate checks) and derived
 * representations such as URL name. Does not save.
 *
 * @param {String} displayName - the new display name for this user (must not contain illegal characters)
 * @memberof User
 * @instance
 */
function setName(displayName) {
  if (typeof displayName != 'string') {
    throw new Error('Username to set must be a string.');
  }

  displayName = displayName.trim();
  this.displayName = displayName;
  this.canonicalName = User.canonicalize(displayName);
  // Regenerate virtual values after setting the name
  this.generateVirtualValues();
}

/**
 * Update a password hash based on a plain text password. Does not save.
 *
 * @param {String} password - plain text password
 * @returns {Promise} promise that resolves to password hashed via bcrypt algorithm
 * @memberof User
 * @instance
 */
function setPassword(password) {
  let user = this;
  return new Promise((resolve, reject) => {
    if (typeof password != 'string') {
      reject(new Error('Password must be a string.'));
    }

    if (password.length < userOptions.minPasswordLength) {
      // This check can't be run as a validator since by then it's a fixed-length hash
      reject(new NewUserError({
        message: 'Password for new user is too short, must be at least %s characters.',
        userMessage: 'password too short',
        messageParams: [String(userOptions.minPasswordLength)]
      }));
    } else {
      bcrypt.hash(password, BCRYPT_ROUNDS, function(error, hash) {
        if (error) {
          reject(error);
        } else {
          user.password = hash;
          resolve(user.password);
        }
      });
    }
  });
}

/**
 * Check this user's password hash against a provided plain text password.
 *
 * @param {String} password - plain text password
 * @returns {Promise} promise that resolves true/false, or rejects if bcrypt library returns an error.
 * @memberof User
 * @instance
 */
function checkPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, this.password, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Which preferences can be toggled via the API for/by this user? May be
 * restricted in future based on access control limits.
 *
 * @returns {String[]} array of preference names
 * @memberof User
 * @instance
 */
function getValidPreferences() {
  return ['prefersRichTextEditor'];
}

/**
 * @param  {String} name - username to validate
 * @returns {Boolean} true if username contains illegal characters
 * @throws {NewUserError} if user name contains invalid characters
 * @memberof User
 * @protected
 */
function _containsOnlyLegalCharacters(name) {
  if (userOptions.illegalChars.test(name)) {
    throw new NewUserError({
      message: 'Username %s contains invalid characters.',
      messageParams: [name],
      userMessage: 'invalid username characters',
      userMessageParams: [userOptions.illegalCharsReadable]
    });
  } else {
    return true;
  }
}

/**
 * Get the PostgreSQL User model (initialize if needed)
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
*/
async function getPostgresUserModel(dal = null) {
  User = await initializeUserModel(dal);
  return User;
}

/**
 * Error class for reporting registration related problems.
 * Behaves as a normal ReportedError, but comes with built-in translation layer
 * for DB level errors.
 *
 * @param {Object} [options] - error data
 * @param {User} options.payload - user object that triggered this error
 * @param {Error} options.parentError - the original error
 */
class NewUserError extends ReportedError {
  constructor(options) {
    if (typeof options == 'object' && options.parentError instanceof Error &&
      typeof options.payload.user == 'object') {
      switch (options.parentError.message) {
        case 'Value for [email] must be a valid email.':
          options.userMessage = 'invalid email format';
          options.userMessageParams = [options.payload.user.email];
          break;
        case `Value for [display_name] must be shorter than ${userOptions.maxChars}.`:
          options.userMessage = 'username too long';
          options.userMessageParams = [String(userOptions.maxChars)];
          break;
        case `Value for [email] must be shorter than ${userOptions.maxChars}.`:
          options.userMessage = 'email too long';
          options.userMessageParams = [String(userOptions.maxChars)];
          break;
        default:
      }
    }
    super(options);
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const UserHandle = createAutoModelHandle('users', initializeUserModel, {
  staticProperties: {
    options: userOptions
  }
});

module.exports = UserHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeUserModel;
module.exports.initializeUserModel = initializeUserModel; // Backward compatibility
module.exports.getPostgresUserModel = getPostgresUserModel;
module.exports.NewUserError = NewUserError;
