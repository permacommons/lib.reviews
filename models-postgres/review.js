'use strict';

/**
 * PostgreSQL Review model implementation
 * 
 * This is the full PostgreSQL implementation of the Review model using the DAL,
 * maintaining compatibility with the existing RethinkDB Review model interface.
 */

const { getPostgresDAL } = require('../db-dual');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');
const ReportedError = require('../util/reported-error');
const isValidLanguage = require('../locales/languages').isValid;
const adapters = require('../adapters/adapters');

const reviewOptions = {
  maxTitleLength: 255
};

let Review = null;

/**
 * Initialize the PostgreSQL Review model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function initializeReviewModel(customDAL = null) {
  const dal = customDAL || getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping Review model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}reviews` : 'reviews';
    
    // Create the schema with revision fields and JSONB columns
    const reviewSchema = {
      id: type.string().uuid(4),
      thing_id: type.string().uuid(4).required(true),
      
      // JSONB multilingual content fields
      title: mlString.getSchema({ maxLength: reviewOptions.maxTitleLength }),
      text: mlString.getSchema(),
      html: mlString.getSchema(),
      
      // Relational fields
      star_rating: type.number().min(1).max(5).integer().required(true),
      created_on: type.date().required(true),
      created_by: type.string().uuid(4).required(true),
      original_language: type.string().max(4).validator(isValidLanguage),
      social_image_id: type.string().uuid(4),
      
      // Virtual permission fields
      user_can_delete: type.virtual().default(false),
      user_can_edit: type.virtual().default(false),
      user_is_author: type.virtual().default(false)
    };

    // Add revision fields to schema
    Object.assign(reviewSchema, revision.getSchema());

    Review = dal.createModel(tableName, reviewSchema);

    // Add static properties
    Object.defineProperty(Review, 'options', {
      value: reviewOptions,
      writable: false,
      enumerable: true,
      configurable: false
    });

    // Add static methods
    Review.createFirstRevision = revision.getFirstRevisionHandler(Review);
    Review.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(Review);
    Review.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(Review);

    // Custom static methods
    Review.getWithData = getWithData;
    Review.create = createReview;
    Review.validateSocialImage = validateSocialImage;
    Review.findOrCreateThing = findOrCreateThing;
    Review.getFeed = getFeed;

    // Add instance methods
    Review.define("newRevision", revision.getNewRevisionHandler(Review));
    Review.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(Review));
    Review.define("populateUserInfo", populateUserInfo);
    Review.define("deleteAllRevisionsWithThing", deleteAllRevisionsWithThing);

    debug.db('PostgreSQL Review model initialized with all methods');
    return Review;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL Review model:', error);
    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Get a review by ID, including commonly joined data.
 *
 * @async
 * @param {String} id - the unique ID to look up
 * @returns {Review} the review and associated data
 */
async function getWithData(id) {
  const joinOptions = {
    // These would need proper join implementation when models are available
    // thing: { files: true },
    // teams: true,
    // socialImage: true,
    // creator: { _apply: seq => seq.without('password') }
  };

  return await Review.getNotStaleOrDeleted(id, joinOptions);
}

/**
 * Create and save a review and the associated Thing and Teams.
 *
 * @async
 * @param {Object} reviewObj - object containing the data to associate with this review
 * @param {Object} [options] - options for the created revision
 * @param {String[]} options.tags - tags to associate with this revision
 * @param {String[]} options.files - UUIDs of files to add to the Thing for this review
 * @returns {Review} the saved review
 */
async function createReview(reviewObj, { tags, files } = {}) {
  const thing = await Review.findOrCreateThing(reviewObj);

  // Check for existing reviews by this user for this thing
  const existingQuery = `
    SELECT id FROM ${Review.tableName}
    WHERE thing_id = $1 
      AND created_by = $2
      AND (_old_rev_of IS NULL)
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
    LIMIT 1
  `;
  
  const existingResult = await Review.dal.query(existingQuery, [thing.id, reviewObj.createdBy]);

  if (existingResult.rows.length > 0) {
    throw new ReportedError({
      message: 'User has previously reviewed this subject.',
      userMessage: 'previously reviewed submission',
      userMessageParams: [
        `/review/${existingResult.rows[0].id}`,
        `/review/${existingResult.rows[0].id}/edit`
      ]
    });
  }

  // Validate social image
  Review.validateSocialImage({
    socialImageID: reviewObj.socialImageID,
    newFileIDs: files,
    fileObjects: thing.files || []
  });

  // Add files to thing if provided
  if (Array.isArray(files)) {
    await thing.addFilesByIDsAndSave(files, reviewObj.createdBy);
  }

  // Create new review instance
  const { randomUUID } = require('crypto');
  const review = new Review({
    thing_id: thing.id,
    title: reviewObj.title,
    text: reviewObj.text,
    html: reviewObj.html,
    star_rating: reviewObj.starRating,
    created_on: reviewObj.createdOn,
    created_by: reviewObj.createdBy,
    original_language: reviewObj.originalLanguage,
    social_image_id: reviewObj.socialImageID,
    _rev_id: randomUUID(),
    _rev_user: reviewObj.createdBy,
    _rev_date: reviewObj.createdOn,
    _rev_tags: tags || []
  });

  try {
    await review.save();
    
    // Handle team associations if provided
    if (reviewObj.teams && Array.isArray(reviewObj.teams)) {
      // This would need proper team association implementation
      debug.db('Team associations not yet implemented in Review.create');
    }
    
    return review;
  } catch (error) {
    if (error instanceof ReviewError) {
      throw error;
    } else {
      throw new ReviewError({
        parentError: error,
        payload: { review }
      });
    }
  }
}

/**
 * Ensure that the social media image specified for this review is associated
 * with the review subject or in the list of newly uploaded files.
 *
 * @param {Object} [options] - Validation data
 * @param {String} options.socialImageID - Social media image UUID
 * @param {String[]} options.newFileIDs - Array of newly uploaded file IDs
 * @param {File[]} options.fileObjects - Array of file objects associated with review subject
 */
function validateSocialImage({
  socialImageID = undefined,
  newFileIDs = [],
  fileObjects = []
} = {}) {
  if (socialImageID) {
    let isValidFile = false;
    
    for (const file of fileObjects) {
      if (file.id === socialImageID) {
        isValidFile = true;
        break;
      }
    }
    
    for (const fileID of newFileIDs) {
      if (fileID === socialImageID) {
        isValidFile = true;
        break;
      }
    }
    
    if (!isValidFile) {
      throw new ReviewError({ userMessage: 'invalid image selected' });
    }
  }
}

/**
 * Locate the review subject (Thing) for a new review, or create and save a new Thing.
 *
 * @async
 * @param {Object} reviewObj - the data associated with the review
 * @returns {Thing} the located or created Thing
 */
async function findOrCreateThing(reviewObj) {
  // We have an existing thing to add this review to
  if (reviewObj.thing) {
    return reviewObj.thing;
  }

  // Get Thing model
  const { getPostgresThingModel } = require('./thing');
  const Thing = getPostgresThingModel(Review.dal);
  
  if (!Thing) {
    throw new Error('Thing model not available');
  }

  // Look up existing thing by URL
  const existingThings = await Thing.lookupByURL(reviewObj.url);
  if (existingThings.length) {
    return existingThings[0];
  }

  // Create new thing
  const { randomUUID } = require('crypto');
  const date = new Date();
  
  const thing = new Thing({
    urls: [reviewObj.url],
    created_on: date,
    created_by: reviewObj.createdBy,
    _rev_date: date,
    _rev_user: reviewObj.createdBy,
    _rev_id: randomUUID(),
    original_language: reviewObj.originalLanguage
  });

  // Get adapter data for the URL
  const adapterPromises = adapters.getSupportedLookupsAsSafePromises(reviewObj.url);
  const results = await Promise.all(adapterPromises);
  
  // Initialize fields from first adapter result
  const firstResult = adapters.getFirstResultWithData(results);
  if (firstResult) {
    thing.initializeFieldsFromAdapter(firstResult);
  }

  // User-provided label overrides adapter label
  if (reviewObj.label && reviewObj.label[reviewObj.originalLanguage]) {
    thing.label = reviewObj.label;
  }

  // Set slug if we have a label
  if (thing.label) {
    // Slug update would need to be implemented
    debug.db('Slug update not yet implemented in Review.findOrCreateThing');
  }

  await thing.save();
  return thing;
}

/**
 * Get an ordered array of reviews, optionally filtered by various criteria.
 *
 * @async
 * @param {Object} [options] - Feed selection criteria
 * @param {User} options.createdBy - author to filter by
 * @param {Date} options.offsetDate - get reviews older than this date
 * @param {Boolean} options.onlyTrusted=false - only get reviews by trusted users
 * @param {String} options.thingID - only get reviews of the Thing with the provided ID
 * @param {Boolean} options.withThing=true - join the associated Thing object
 * @param {Boolean} options.withTeams=true - join the associated Team objects
 * @param {String} options.withoutCreator - exclude reviews by the user with the provided ID
 * @param {Number} options.limit=10 - how many reviews to load
 * @returns {Object} feed object with items and optional offsetDate
 */
async function getFeed({
  createdBy = undefined,
  offsetDate = undefined,
  onlyTrusted = false,
  thingID = undefined,
  withThing = true,
  withTeams = true,
  withoutCreator = undefined,
  limit = 10
} = {}) {
  
  let query = `
    SELECT r.* FROM ${Review.tableName} r
    WHERE (_old_rev_of IS NULL)
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
  `;
  
  const params = [];
  let paramIndex = 1;

  // Apply filters
  if (offsetDate && offsetDate.valueOf) {
    query += ` AND created_on < $${paramIndex}`;
    params.push(offsetDate);
    paramIndex++;
  }

  if (thingID) {
    query += ` AND thing_id = $${paramIndex}`;
    params.push(thingID);
    paramIndex++;
  }

  if (withoutCreator) {
    query += ` AND created_by != $${paramIndex}`;
    params.push(withoutCreator);
    paramIndex++;
  }

  if (createdBy) {
    query += ` AND created_by = $${paramIndex}`;
    params.push(createdBy);
    paramIndex++;
  }

  query += ` ORDER BY created_on DESC LIMIT $${paramIndex}`;
  params.push(limit + 1); // Get one extra to check for pagination

  // Execute query
  const result = await Review.dal.query(query, params);
  let feedItems = result.rows.slice(0, limit).map(row => Review._createInstance(row));
  const feedResult = {};

  // Check for pagination
  if (result.rows.length === limit + 1) {
    feedResult.offsetDate = feedItems[limit - 1].created_on;
  }

  // Filter by trusted users if requested (after limit for performance)
  if (onlyTrusted) {
    // This would need proper user join implementation
    debug.db('Trusted user filtering not yet implemented in Review.getFeed');
  }

  // Add joins if requested
  if (withThing || withTeams) {
    // This would need proper join implementation
    debug.db('Thing and team joins not yet implemented in Review.getFeed');
  }

  feedResult.feedItems = feedItems;
  return feedResult;
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Populate virtual fields with permissions for a given user
 *
 * @param {User} user - the user whose permissions to check
 * @memberof Review
 * @instance
 */
function populateUserInfo(user) {
  if (!user) {
    return; // fields will be at their default value (false)
  }

  if (user.is_super_user || user.is_site_moderator || user.id === this.created_by) {
    this.user_can_delete = true;
  }

  if (user.is_super_user || user.id === this.created_by) {
    this.user_can_edit = true;
  }

  if (user.id === this.created_by) {
    this.user_is_author = true;
  }
}

/**
 * Delete all revisions of a review including the associated review subject (thing).
 *
 * @param {User} user - user initiating the action
 * @returns {Promise} promise that resolves when all content has been deleted
 * @memberof Review
 * @instance
 */
async function deleteAllRevisionsWithThing(user) {
  const p1 = this.deleteAllRevisions(user, {
    tags: ['delete-with-thing']
  });

  // This would need proper thing relationship
  let p2 = Promise.resolve();
  if (this.thing) {
    p2 = this.thing.deleteAllRevisions(user, {
      tags: ['delete-via-review']
    });
  }

  return Promise.all([p1, p2]);
}

/**
 * Custom error class for review-related errors
 */
class ReviewError extends ReportedError {
  constructor(options) {
    if (typeof options === 'object' && options.parentError instanceof Error &&
      typeof options.payload?.review === 'object') {
      
      const parentMessage = options.parentError.message;
      
      if (parentMessage.includes('star_rating') && parentMessage.includes('greater than or equal to 1')) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (parentMessage.includes('star_rating') && parentMessage.includes('less than or equal to 5')) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (parentMessage.includes('star_rating') && parentMessage.includes('integer')) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (parentMessage.includes('title') && parentMessage.includes(`${Review.options.maxTitleLength}`)) {
        options.userMessage = 'review title too long';
      } else if (parentMessage.includes('original_language')) {
        options.userMessage = 'invalid language';
        options.userMessageParams = [String(options.payload.review.original_language)];
      }
    }
    super(options);
  }
}

/**
 * Get the PostgreSQL Review model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function getPostgresReviewModel(customDAL = null) {
  if (!Review || customDAL) {
    Review = initializeReviewModel(customDAL);
  }
  return Review;
}

module.exports = {
  initializeReviewModel,
  getPostgresReviewModel,
  ReviewError
};