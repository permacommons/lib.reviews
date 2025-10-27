'use strict';

/**
 * Model for user accounts. Note that unlike the linked {@link UserMeta}
 * model, this table is not versioned.
 *
 * @namespace User
 */

const thinky = require('../db');
const type = thinky.type;
const Errors = thinky.Errors;
const r = thinky.r;
const bcrypt = require('bcrypt');
const ReportedError = require('../util/reported-error');
const UserMeta = require('./user-meta');

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

/* eslint-disable newline-per-chained-call */
/* for schema readability */
let User = thinky.createModel("users", {
  id: type.string(),
  displayName: type.string()
    .max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
  canonicalName: type.string()
    .max(userOptions.maxChars).validator(_containsOnlyLegalCharacters).required(),
  urlName: type.virtual().default(function() {
    return this.displayName ? encodeURIComponent(this.displayName.replace(/ /g, '_')) : undefined;
  }),
  email: type.string().max(userOptions.maxChars).email(),
  // Password existence requirement is enforced by pre-save hook - see below
  password: type.string(),
  userMetaID: type.string().uuid(4), // Versioned
  // Trusted users gain invite codes as they write reviews
  inviteLinkCount: type.number().integer().default(0),
  registrationDate: type.date().default(() => new Date()),
  showErrorDetails: type.boolean().default(false),
  // Basic trust - not a spammer. Can confer trust, can edit things + create teams
  isTrusted: type.boolean().default(false),
  // Advanced trust - can (reversibly) delete content, but _not_ edit arbitrary content
  isSiteModerator: type.boolean().default(false),
  // Can do anything
  isSuperUser: type.boolean().default(false),
  suppressedNotices: [type.string()],
  // Permission field, populated using _currently logged in user_, to determine
  // whether they can edit _this_ user's metadata.
  userCanEditMetadata: type.virtual().default(false),
  // Temp files are not associated with a specific review subject yet, so the
  // permission exists at the user level
  userCanUploadTempFiles: type.virtual().default(function() {
    return this.isTrusted || this.isSuperUser;
  }),
  prefersRichTextEditor: type.boolean().default(false)
});

// Relations. For team relations see team model

User.belongsTo(UserMeta, "meta", "userMetaID", "id");


// Thinky validates models on save AND retrieval, and we sometimes want to
// filter out password hashes from user models to eliminate any risk of
// accidental exposure. Using required() in the schema would cause those lookups
// to fail, so instead, we enforce the requirement when saving.
User.pre('save', function(next) {
  if (!this.password || typeof this.password != 'string')
    throw new Error('Password must be set to a non-empty string.');
  next();
});

User.options = userOptions; // for external visibility
Object.freeze(User.options);

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Increase the invite link count by 1 for a given user
 *
 * @param {String} id
 *  unique ID of the user
 * @returns {Number}
 *  updated invite count
 * @async
 */
User.increaseInviteLinkCount = async function(id) {
  const updatedUser = await User.get(id).update({
    inviteLinkCount: r.row("inviteLinkCount").add(1)
  });
  return updatedUser.inviteLinkCount;
};

/**
 * Create a new user from an object containing the user data. Hashes the
 * password, checks for uniqueness, validates. Saves.
 *
 * @param {Object} userObj
 *  plain object containing data supported by this model
 * @returns {User}
 *  the created user
 * @throws {NewUserError}
 *  if user exists, password is too short, or there are other validation
 *  problems.
 * @async
 */
User.create = async function(userObj) {
  const user = new User({});
  if (typeof userObj != 'object')
    throw new NewUserError({
      message: 'We need a user object containing the user data to create a new user.',
    });

  try {
    user.setName(userObj.name);
    // we have to check, because assigning an empty string would trigger the
    // validation to kick in
    if (userObj.email)
      user.email = userObj.email;
    await User.ensureUnique(userObj.name); // throws if exists
    await user.setPassword(userObj.password); // throws if too short
    await user.save();
  } catch (error) {
    throw error instanceof NewUserError ?
      error :
      new NewUserError({ payload: { user }, parentError: error });
  }
  return user;
};

/**
 * Throw if we already have a user with this name.
 *
 * @param {String} name
 *  username to check
 * @returns {Boolean}
 *  true if unique
 * @throws {NewUserError}
 *  if exists
 * @async
 */
User.ensureUnique = async function(name) {
  if (typeof name != 'string')
    throw new Error('Username to check must be a string.');

  name = name.trim();
  const users = await User.filter({ canonicalName: User.canonicalize(name) });
  if (users.length)
    throw new NewUserError({
      message: 'A user named %s already exists.',
      userMessage: 'username exists',
      messageParams: [name]
    });
  return true;
};

/**
 * Obtain user and all associated teams
 *
 * @param {String} id
 *  user ID to look up
 * @returns {Query}
 */
User.getWithTeams = function(id) {
  return User
    .get(id)
    .getJoin({
      teams: true
    });
};

/**
 * Find a user by the urldecoded URL name (spaces replaced with underscores)
 *
 * @param {String} name
 *  decoded URL name
 * @param {Object} [options]
 *  query criteria
 * @param {Boolean} options.withPassword=false
 *  if false, password will be filtered from result. Subsequent save() calls
 *  will throw an error
 * @param {Boolean} options.withData=false
 *  if true, the associated user-metadata object will be joined to the user
 * @param {Boolean} options.withTeams=false
 *  if true, the associated teams will be joined to the user
 *
 * @returns {User}
 *  the matching user object
 * @throws {ThinkyError}
 *  if not found
 * @async
 */
User.findByURLName = async function(name, {
  withPassword = false,
  withData = false,
  withTeams = false
} = {}) {

  name = name.trim().replace(/_/g, ' ');

  let query = User.filter({ canonicalName: User.canonicalize(name) });

  if (!withPassword)
    query = query.without('password');

  if (withData)
    query = query.getJoin({ meta: true });

  if (withTeams)
    query = query.getJoin({ teams: true }).getJoin({ moderatorOf: true });

  const users = await query;
  if (users.length)
    return users[0];
  else
    throw new Errors.DocumentNotFound('User not found');
};

/**
 * Transform a user name to its canonical internal form (upper case), used for
 * duplicate checking.
 *
 * @param {String} name
 *  name to transform
 * @returns {String}
 *  canoncial form
 */
User.canonicalize = function(name) {
  return name.toUpperCase();
};

/**
 * Associate a new bio text with a given user and save both
 *
 * @param {User} user
 *  user object to associate the bio with
 * @param {Object} bioObj
 *  plain object with data conforming to UserMeta schema
 * @returns {User}
 *  updated user
 * @async
 */
User.createBio = async function(user, bioObj) {
  const uuid = await r.uuid();
  let userMeta = new UserMeta(bioObj);
  userMeta._revID = uuid;
  userMeta._revUser = user.id;
  userMeta._revDate = new Date();
  userMeta._revTags = ['create-bio-via-user'];
  await userMeta.save(); // sets ID
  user.userMetaID = userMeta.id;
  await user.save();
  return user;
};

// NOTE: INSTANCE METHODS ------------------------------------------------------

User.define("populateUserInfo", populateUserInfo);
User.define("setName", setName);
User.define("setPassword", setPassword);
User.define("checkPassword", checkPassword);
User.define("getValidPreferences", getValidPreferences);

/**
 * Determine what the provided user (typically the currently logged in user)
 * may do with the data associated with this User object, and populate its
 * permission fields accordingly.
 *
 * @param {User} user
 *  user whose permissions on this User object we want to determine
 * @memberof User
 * @instance
 */
function populateUserInfo(user) {

  if (!user)
    return; // Permissions at default (false)

  // For now, only the user may edit metadata like bio.
  // In future, translators may also be able to.
  if (user.id == this.id)
    this.userCanEditMetadata = true;
}

/**
 * Updates display name, canonical name (used for duplicate checks) and derived
 * representations such as URL name. Does not save.
 *
 * @param {String} displayName
 *  the new display name for this user (must not contain illegal characters)
 * @memberof User
 * @instance
 */
function setName(displayName) {
  if (typeof displayName != 'string')
    throw new Error('Username to set must be a string.');

  displayName = displayName.trim();
  this.displayName = displayName;
  this.canonicalName = User.canonicalize(displayName);
  this.generateVirtualValues();
}

/**
 * Update a password hash based on a plain text password. Does not save.
 *
 * @param {String} password
 *  plain text password
 * @returns {Promise}
 *  promise that resolves to password hashed via bcrpyt algorithm. Rejects
 *  with `NewUserError` if the password is too short, or if bcrypt library
 *  returns an error.
 * @memberof User
 * @instance
 */
function setPassword(password) {
  let user = this;
  return new Promise((resolve, reject) => {
    if (typeof password != 'string')
      reject(new Error('Password must be a string.'));

    if (password.length < userOptions.minPasswordLength) {
      // This check can't be run as a validator since by then it's a fixed-length hash
      reject(new NewUserError({
        message: 'Password for new user is too short, must be at least %s characters.',
        userMessage: 'password too short',
        messageParams: [String(userOptions.minPasswordLength)]
      }));
    } else {
      bcrypt.hash(password, BCRYPT_ROUNDS, function(error, hash) {
        if (error)
          reject(error);
        else {
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
 * @param {String} password
 *  plain text password
 * @returns {Promise}
 *  promise that resolves true/false, or rejects if bcrypt library returns
 *  an error.
 * @memberof User
 * @instance
 */
function checkPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, this.password, function(error, result) {
      if (error)
        reject(error);
      else
        resolve(result);
    });
  });
}

/**
 * Which preferences can be toggled via the API for/by this user? May be
 * restricted in future based on access control limits.
 *
 * @returns {String[]}
 *  array of preference names
 * @memberof User
 * @instance
 */
function getValidPreferences() {
  return ['prefersRichTextEditor'];
}


/**
 * @param  {String} name
 *  username to validate
 * @returns {Boolean}
 *  true if username contains illegal characters
 * @throws {NewUserError}
 *  if user name contains invalid characters
 * @memberof User
 * @protected
 */
function _containsOnlyLegalCharacters(name) {
  if (userOptions.illegalChars.test(name))
    throw new NewUserError({
      message: 'Username %s contains invalid characters.',
      messageParams: [name],
      userMessage: 'invalid username characters',
      userMessageParams: [userOptions.illegalCharsReadable]
    });
  else
    return true;
}

module.exports = User;

/**
 * Error class for reporting registration related problems.
 * Behaves as a normal ReportedError, but comes with built-in translation layer
 * for DB level errors.
 *
 * @param {Object} [options]
 *  error data
 * @param {User} options.payload
 *  user object that triggered this error
 * @param {Error} options.parentError
 *  the original error
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
        case `Value for [displayName] must be shorter than ${User.options.maxChars}.`:
          options.userMessage = 'username too long';
          options.userMessageParams = [String(User.options.maxChars)];
          break;
        case `Value for [email] must be shorter than ${User.options.maxChars}.`:
          options.userMessage = 'email too long';
          options.userMessageParams = [String(User.options.maxChars)];
          break;
        default:
      }
    }
    super(options);
  }
}
