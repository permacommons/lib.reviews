'use strict';

/**
 * Model for reviews, including the full text.
 *
 * @namespace Review
 */

const thinky = require('../db');
const type = thinky.type;
const r = thinky.r;
const mlString = require('./helpers/ml-string');

const ReportedError = require('../util/reported-error');
const User = require('./user');
const Thing = require('./thing');
const File = require('./file');

const revision = require('./helpers/revision');
const isValidLanguage = require('../locales/languages').isValid;
const adapters = require('../adapters/adapters');

const reviewOptions = {
  maxTitleLength: 255
};

/* eslint-disable newline-per-chained-call */
/* for schema readability */

let reviewSchema = {
  id: type.string().uuid(4),
  thingID: type.string().uuid(4),
  title: mlString.getSchema({
    maxLength: reviewOptions.maxTitleLength
  }),
  text: mlString.getSchema(),
  html: mlString.getSchema(),
  starRating: type.number().min(1).max(5).integer(),

  // Track original authorship across revisions
  createdOn: type.date().required(true),
  createdBy: type.string().uuid(4).required(true),
  // We track this for all objects where we want to be able to handle
  // translation permissions separately from edit permissions
  originalLanguage: type.string().max(4).validator(isValidLanguage),

  socialImageID: type.string().uuid(4),

  // These can only be populated from the outside using a user object
  userCanDelete: type.virtual().default(false),
  userCanEdit: type.virtual().default(false),
  userIsAuthor: type.virtual().default(false)
};

/* eslint-enable newline-per-chained-call */
/* for schema readability */

// Add versioning related fields
Object.assign(reviewSchema, revision.getSchema());

// Table generation is handled by thinky. URLs for reviews are stored as "things".
let Review = thinky.createModel("reviews", reviewSchema);

Review.options = reviewOptions;
Object.freeze(Review.options);

Review.belongsTo(User, "creator", "createdBy", "id");
Review.belongsTo(Thing, "thing", "thingID", "id");
Review.belongsTo(File, "socialImage", "socialImageID", "id");
Thing.hasMany(Review, "reviews", "id", "thingID");
Review.ensureIndex("createdOn");


// NOTE: STATIC METHODS START HERE ---------------------------------------------

// Standard handlers -----------------------------------------------------------

Review.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(Review);
Review.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(Review);

// Custom methods --------------------------------------------------------------

/**
 * Get a review by ID, including commonly joined data: the review subject
 * (thing), the user who created the review, and the teams with which it was
 * associated. **WARNING:** since the password is filtered out, any future calls
 * to `saveAll()` must be explicitly parametrized to *not* include the user, or
 * the save will throw an error.
 *
 * @async
 * @param {String} id
 *  the unique ID to look up
 * @returns {Review}
 *  the review and associated data
 */
Review.getWithData = async function(id) {
  return await Review
    .getNotStaleOrDeleted(id, {
      thing: {
        files: true,
      },
      teams: true,
      socialImage: true,
      creator: {
        _apply: seq => seq.without('password')
      }
    });
};

/**
 * Create and save a review and the associated Thing and Teams. If there is no
 * Thing record, this function creates and saves one via
 * {@link Review.findOrCreateThing}.
 *
 * @async
 * @param {Object} reviewObj
 *  object containing the data to associate with this review, as defined in
 *  Review schema.
 * @param {Object} [options]
 *  options for the created revision
 * @param {String[]} options.tags
 *  tags to associate with this revision
 * @param {String[]} options.files
 *  UUIDs of files to add to the Thing for this review
 * @returns {Review}
 *  the saved review
 */
Review.create = async function(reviewObj, { tags, files } = {}) {
  const thing = await Review.findOrCreateThing(reviewObj);

  const existingReviews = await Review
    .filter({
      thingID: thing.id,
      createdBy: reviewObj.createdBy
    })
    .filter({ _oldRevOf: false }, { default: true })
    .filter({ _revDeleted: false }, { default: true });

  if (existingReviews.length)
    throw new ReportedError({
      message: 'User has previously reviewed this subject.',
      userMessage: 'previously reviewed submission',
      userMessageParams: [
          `/review/${existingReviews[0].id}`,
          `/review/${existingReviews[0].id}/edit`
      ]
    });

  // Only images associated with the review subject can be selected
  Review.validateSocialImage({
    socialImageID: reviewObj.socialImageID,
    newFileIDs: files,
    fileObjects: thing.files
  });

  // If we uploaded files in the process of writing this review, we add them
  // to the associated review subject
  if (Array.isArray(files))
    await thing.addFilesByIDsAndSave(files, reviewObj.createdBy);

  let review = new Review({
    thing, // joined
    teams: reviewObj.teams, // joined
    title: reviewObj.title,
    text: reviewObj.text,
    html: reviewObj.html,
    starRating: reviewObj.starRating,
    createdOn: reviewObj.createdOn,
    createdBy: reviewObj.createdBy,
    originalLanguage: reviewObj.originalLanguage,
    socialImageID: reviewObj.socialImageID,
    _revID: r.uuid(),
    _revUser: reviewObj.createdBy,
    _revDate: reviewObj.createdOn,
    _revTags: tags
  });
  try {
    return await review.saveAll({
      teams: true,
      thing: true
    });
  } catch (error) {
    if (error instanceof ReviewError)
      throw error;
    else
      throw new ReviewError({
        parentError: error,
        payload: {
          review
        }
      });
  }
};

/**
 * Ensure that the social media image specified for this review is associated
 * already with the review subject, or in the list of newly uploaded files.
 * Throws a ReviewError if not.
 *
 * @param {Object} [options]
 *  Validation data
 * @param {String} options.socialImageID
 *  Social media image UUID
 * @param {String[]} options.newFileIDs
 *  Array of newly uploaded file IDs
 * @param {File[]} options.fileObjects
 *  Array of previously uploaded file objects associated with review subject
 *
 */
Review.validateSocialImage = function({
  socialImageID = undefined,
  newFileIDs = [],
  fileObjects = []
  } = {}) {

  if (socialImageID) {
    let isValidFile = false;
    for (let file of fileObjects) {
      if (file.id == socialImageID)
        isValidFile = true;
    }
    for (let fileID of newFileIDs) {
      if (fileID == socialImageID)
        isValidFile = true;
    }
    if (!isValidFile)
      throw new ReviewError({ userMessage: 'invalid image selected' });
  }
};


/**
 * Locate the review subject (Thing) for a new review, or create and save a new
 * Thing based on the provided URL. This will also perform adapter lookups for
 * external metadata (e.g., from Wikidata).
 *
 * This function is called from {@link Review.create}.
 *
 * @async
 * @param {Object} reviewObj
 *  the data associated with the review we're locating or creating a Thing
 *  record for
 * @returns {Thing}
 *  the located or created Thing
 */
Review.findOrCreateThing = async function(reviewObj) {
  // We have an existing thing to add this review to
  if (reviewObj.thing)
    return reviewObj.thing;

  let queries = [
    Thing.lookupByURL(reviewObj.url),
    // Look up this URL in adapters that support it. Promises will not reject,
    // so can be added to Promise.all below. Order is specified in adapters.js
    // and is important (see below)
    ...adapters.getSupportedLookupsAsSafePromises(reviewObj.url)
  ];

  const results = await Promise.all(queries);
  let things = results.shift();
  if (things.length)
    return things[0]; // we have an entry with this URL already

  // Let's make one!
  let thing = new Thing({});
  let date = new Date();
  thing.urls = [reviewObj.url];
  thing.createdOn = date;
  thing.createdBy = reviewObj.createdBy;
  thing._revDate = date;
  thing._revUser = reviewObj.createdBy;
  thing._revID = r.uuid();
  thing.originalLanguage = reviewObj.originalLanguage;

  // The first result ("first" in the array of adapters) for the URL
  // specified by the user will be used to initalize values like label,
  // description, subtitle, authors, or other supported fields. These
  // fields will also be set to read-only, with synchronization metadata
  // stored in the thing.sync property.
  thing.initializeFieldsFromAdapter(adapters.getFirstResultWithData(results));

  // If the user provided a valid label, it always overrides any label
  // from an adapter.
  if (reviewObj.label && reviewObj.label[reviewObj.originalLanguage])
    thing.label = reviewObj.label;

  // Set short identifier (slug) if we have a label for this review subject
  if (thing.label)
    thing = await thing.updateSlug(reviewObj.createdBy, reviewObj.originalLanguage);

  thing = await thing.save();
  return thing;
};


/**
 * Get an ordered array of reviews, optionally filtered by user, date, review
 * subject, and other criteria.
 *
   @async
 * @param {Object} [options]
 *  Feed selection criteria
 * @param {User} options.createdBy
 *  author to filter by
 * @param {Date} options.offsetDate
 *  get reviews older than this date
 * @param {Boolean} options.onlyTrusted=false
 *  only get reviews by users whose user.isTrusted is truthy. Is applied after
 *  the limit, so you may end up with fewer reviews than specified.
 * @param {String} options.thingID
 *  only get reviews of the Thing with the provided ID
 * @param {Boolean} options.withThing=true
 *  join the associated Thing object with each review
 * @param {Boolean} options.withTeams=true
 *  join the associated Team objects with each review
 * @param {String} options.withoutCreator
 *  exclude reviews by the user with the provided ID
 * @param {Number} options.limit=10
 *  how many reviews to load
 *
 * @returns {Review[]}
 *  the reviews matching the provided criteria
 */
Review.getFeed = async function({
  createdBy = undefined,
  offsetDate = undefined,
  onlyTrusted = false,
  thingID = undefined,
  withThing = true,
  withTeams = true,
  withoutCreator = undefined,
  limit = 10
} = {}) {

  let query = Review;

  if (offsetDate && offsetDate.valueOf)
    query = query.between(r.minval, r.epochTime(offsetDate.valueOf() / 1000), {
      index: 'createdOn',
      rightBound: 'open' // Do not return previous record that exactly matches offset
    });

  query = query.orderBy({ index: r.desc('createdOn') });

  if (thingID)
    query = query.filter({ thingID });

  if (withoutCreator)
    query = query.filter(r.row("createdBy").ne(withoutCreator));

  if (createdBy)
    query = query.filter({ createdBy });

  query = query
    .filter(r.row('_revDeleted').eq(false), { default: true }) // Exclude deleted
    .filter(r.row('_oldRevOf').eq(false), { default: true }) // Exclude old
    .limit(limit + 1); // One over limit to check if we need potentially another set

  if (withThing)
    query = query.getJoin({ thing: true });

  if (withTeams)
    query = query.getJoin({ teams: true });

  query = query.getJoin({
    creator: {
      _apply: seq => seq.without('password')
    }
  });

  let feedItems = await query;
  const result = {};

  // At least one additional document available, set offset for pagination
  if (feedItems.length == limit + 1) {
    result.offsetDate = feedItems[limit - 1].createdOn;
    feedItems.pop();
  }

  if (onlyTrusted)
    feedItems = feedItems.filter(item => item.creator.isTrusted ? true : false);

  result.feedItems = feedItems;
  return result;

};

// NOTE: INSTANCE METHODS START HERE -------------------------------------------

// Standard handlers -----------------------------------------------------------

Review.define("newRevision", revision.getNewRevisionHandler(Review));
Review.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(Review));

// Custom methods

Review.define("populateUserInfo", populateUserInfo);
Review.define("deleteAllRevisionsWithThing", deleteAllRevisionsWithThing);

/**
 * Populate virtual fields with permissions for a given user
 *
 * @param {User} user
 *  the user whose permissions to check
 * @memberof Review
 * @instance
 */
function populateUserInfo(user) {
  if (!user)
    return; // fields will be at their default value (false)

  if (user.isSuperUser || user.isSiteModerator || user.id === this.createdBy)
    this.userCanDelete = true;

  if (user.isSuperUser || user.id === this.createdBy)
    this.userCanEdit = true;

  if (user.id === this.createdBy)
    this.userIsAuthor = true;
}

/**
 * Delete all revisions of a review including the associated review subject
 * (thing).
 *
 * @param {User} user
 *  user initiating the action
 * @returns {Promise}
 *  promise that resolves when all content has been deleted
 * @memberof Review
 * @instance
 */
function deleteAllRevisionsWithThing(user) {

  let p1 = this
    .deleteAllRevisions(user, {
      tags: ['delete-with-thing']
    });

  // We rely on the thing property having been populated. This will fail on
  // a shallow Review object!
  let p2 = this.thing
    .deleteAllRevisions(user, {
      tags: ['delete-via-review']
    });

  return Promise.all([p1, p2]);

}

/**
 * Custom error class that detects validation errors reported by the model
 * and translates them to internationalized messages
 */
class ReviewError extends ReportedError {

  /**
   * @param {Object} [options]
   *  error data
   * @param {Review} options.payload
   *  the review that triggered this error
   * @param {Error} options.parentError
   *  the original error
   */
  constructor(options) {
    if (typeof options == 'object' && options.parentError instanceof Error &&
      typeof options.payload.review == 'object') {
      switch (options.parentError.message) {
        case 'Value for [starRating] must be greater than or equal to 1.':
        case 'Value for [starRating] must be less than or equal to 5.':
        case 'Value for [starRating] must be an integer.':
        case 'Value for [starRating] must be a finite number or null.':
          options.userMessage = 'invalid star rating';
          options.userMessageParams = [String(options.payload.review.starRating)];
          break;
        case `Value for [title][${options.payload.review.originalLanguage}] must not be longer than ${Review.options.maxTitleLength}.`:
          options.userMessage = 'review title too long';
          break;
        case 'Validator for the field [originalLanguage] returned `false`.':
          options.userMessage = 'invalid language';
          options.userMessageParams = [String(options.payload.review.originalLanguage)];
          break;
        default:
      }
    }
    super(options);
  }

}

module.exports = Review;
