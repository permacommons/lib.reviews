'use strict';

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');
const ReportedError = require('../util/reported-error');
const isValidLanguage = require('../locales/languages').isValid;
const adapters = require('../adapters/adapters');
const { initializeModel } = require('../dal/lib/model-initializer');

const reviewOptions = {
  maxTitleLength: 255
};

let Review = null;

/**
 * Initialize the PostgreSQL Review model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeReviewModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping Review model initialization');
    return null;
  }

  try {
    // Create the schema with revision fields and JSONB columns
    const reviewSchema = {
      id: type.string().uuid(4),
      
      // CamelCase schema fields that map to snake_case database columns
      thingID: type.string().uuid(4).required(true),

      // JSONB multilingual content fields
      title: mlString.getSchema({ maxLength: reviewOptions.maxTitleLength }),
      text: mlString.getSchema(),
      html: mlString.getSchema(),

      // Relational fields
      starRating: type.number().min(1).max(5).integer().required(true),
      createdOn: type.date().required(true),
      createdBy: type.string().uuid(4).required(true),
      originalLanguage: type.string().max(4).validator(isValidLanguage),
      socialImageID: type.string().uuid(4),

      // Virtual permission fields
      userCanDelete: type.virtual().default(false),
      userCanEdit: type.virtual().default(false),
      userIsAuthor: type.virtual().default(false)
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'reviews',
      schema: reviewSchema,
      camelToSnake: {
        thingID: 'thing_id',
        starRating: 'star_rating',
        createdOn: 'created_on',
        createdBy: 'created_by',
        originalLanguage: 'original_language',
        socialImageID: 'social_image_id'
      },
      withRevision: true,
      staticMethods: {
        getWithData,
        create: createReview,
        validateSocialImage,
        findOrCreateThing,
        getFeed
      },
      instanceMethods: {
        populateUserInfo,
        deleteAllRevisionsWithThing
      },
      relations: [
        {
          name: 'thing',
          targetTable: 'things',
          sourceKey: 'thing_id',
          targetKey: 'id',
          hasRevisions: true,
          cardinality: 'one'
        },
        {
          name: 'creator',
          targetTable: 'users',
          sourceKey: 'created_by',
          targetKey: 'id',
          hasRevisions: false,
          cardinality: 'one'
        },
        {
          name: 'socialImage',
          targetTable: 'files',
          sourceKey: 'social_image_id',
          targetKey: 'id',
          hasRevisions: true,
          cardinality: 'one'
        }
      ]
    });
    Review = model;

    if (!isNew) {
      return Review;
    }

    Object.defineProperty(Review, 'options', {
      value: reviewOptions,
      writable: false,
      enumerable: true,
      configurable: false
    });

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
  // Get the review first
  const review = await Review.getNotStaleOrDeleted(id);

  if (!review) {
    return null;
  }

  // Manually join creator data
  if (review.createdBy) {
    try {
      const userQuery = `
        SELECT id, display_name, canonical_name, email, registration_date, 
               is_trusted, is_site_moderator, is_super_user
        FROM users 
        WHERE id = $1
      `;

      const userResult = await Review.dal.query(userQuery, [review.createdBy]);

      if (userResult.rows.length > 0) {
        const creator = userResult.rows[0];
        // Map snake_case to camelCase for template compatibility
        const safeCreator = {
          ...creator,
          displayName: creator.display_name,
          urlName: creator.display_name ? encodeURIComponent(creator.display_name.replace(/ /g, '_')) : undefined
        };
        review.creator = safeCreator;
      }
    } catch (error) {
      debug.db('Failed to fetch creator for review:', error.message);
    }
  }

  // Manually join thing data
  if (review.thingID) {
    try {
      const { getPostgresThingModel } = require('./thing');
      const ThingModel = await getPostgresThingModel(Review.dal);
      if (ThingModel) {
        const thing = await ThingModel.getNotStaleOrDeleted(review.thingID);
        if (thing) {
          review.thing = thing;
        }
      }
    } catch (error) {
      debug.db('Failed to fetch thing for review:', error);
    }
  }

  return review;
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
  const reviewId = reviewObj.id || undefined;

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
  const review = new Review();
  review.thingID = thing.id;
  review.title = reviewObj.title;
  review.text = reviewObj.text;
  review.html = reviewObj.html;
  review.starRating = reviewObj.starRating;
  review.createdOn = reviewObj.createdOn;
  review.createdBy = reviewObj.createdBy;
  review.originalLanguage = reviewObj.originalLanguage;
  review.socialImageID = reviewObj.socialImageID;
  revision.applyRevisionMetadata(review, {
    userId: reviewObj.createdBy,
    date: reviewObj.createdOn,
    tags
  });

  try {
    await review.save();

    // Handle team associations if provided
    if (reviewObj.teams && Array.isArray(reviewObj.teams)) {
      // This would need proper team association implementation
      debug.db('Team associations not yet implemented in Review.create');
    }

    review.thing = thing;

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

  const { getPostgresThingModel } = require('./thing');
  const ThingModel = await getPostgresThingModel(Review.dal);

  if (!ThingModel || typeof ThingModel.createFirstRevision !== 'function') {
    throw new Error('Thing model not available');
  }

  // Look up existing thing by URL
  debug.db('Review.findOrCreateThing: lookup by URL', { url: reviewObj.url });
  const existingThings = await ThingModel.lookupByURL(reviewObj.url);
  if (existingThings.length) {
    debug.db('Review.findOrCreateThing: existing thing found', { thingID: existingThings[0].id });
    return existingThings[0];
  }

  // Create new thing
  const { randomUUID } = require('crypto');
  const date = new Date();

  const thing = await ThingModel.createFirstRevision(
    { id: reviewObj.createdBy },
    { tags: ['create-via-review'], date }
  );
  debug.db('Review.findOrCreateThing: created first revision', { provisionalThingID: thing.id });

  if (!thing.id) {
    thing.id = randomUUID();
    debug.db('Review.findOrCreateThing: generated new thing ID', { thingID: thing.id });
  }

  thing.urls = [reviewObj.url];
  thing.createdOn = date;
  thing.createdBy = reviewObj.createdBy;
  thing.originalLanguage = reviewObj.originalLanguage;

  // Ensure revision metadata is aligned with the created review
  revision.applyRevisionMetadata(thing, {
    userId: reviewObj.createdBy,
    date,
    tags: ['create-via-review']
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

  await thing.save();

  // Set slug if we have a label (after initial save to satisfy FK constraint)
  if (thing.label) {
    await thing.updateSlug(reviewObj.createdBy, reviewObj.originalLanguage || 'en');
    if (thing._changed.size) {
      await thing.save();
    }
  }
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
  if (result.rows.length === limit + 1 && feedItems.length > 0) {
    const lastVisible = feedItems[feedItems.length - 1];
    const offsetCandidate = lastVisible.createdOn || lastVisible.created_on;
    if (offsetCandidate instanceof Date) {
      feedResult.offsetDate = offsetCandidate;
    } else if (offsetCandidate) {
      feedResult.offsetDate = new Date(offsetCandidate);
    }
  }

  // Filter by trusted users if requested (after limit for performance)
  if (onlyTrusted) {
    // This would need proper user join implementation
    debug.db('Trusted user filtering not yet implemented in Review.getFeed');
  }

  // Add joins if requested
  if (withThing || withTeams) {
    // Populate creator information for each review using batch query
    try {
      // Get unique user IDs from reviews
      const userIds = [...new Set(feedItems.map(review => review.createdBy).filter(Boolean))];

      if (userIds.length > 0) {
        debug.db(`Batch fetching ${userIds.length} unique creators...`);

        // Batch query for all users at once
        const userQuery = `
          SELECT id, display_name, canonical_name, email, registration_date, 
                 is_trusted, is_site_moderator, is_super_user
          FROM users 
          WHERE id = ANY($1)
        `;

        const userResult = await Review.dal.query(userQuery, [userIds]);

        // Create a map of user ID to user data for fast lookup
        const userMap = new Map();
        userResult.rows.forEach(user => {
          // Map snake_case to camelCase for template compatibility
          const safeUser = {
            ...user,
            displayName: user.display_name,
            urlName: user.display_name ? encodeURIComponent(user.display_name.replace(/ /g, '_')) : undefined
          };
          userMap.set(user.id, safeUser);
        });

        // Assign creators to reviews
        feedItems.forEach(review => {
          if (review.createdBy && userMap.has(review.createdBy)) {
            review.creator = userMap.get(review.createdBy);
          }
        });

        debug.db(`Successfully populated creators for ${userResult.rows.length} users`);
      }
    } catch (error) {
      debug.error('Failed to batch fetch creators:', error.message);
    }

    if (withThing) {
      try {
        const thingIds = [...new Set(feedItems.map(review => review.thingID).filter(Boolean))];

        if (thingIds.length > 0) {
          const { getPostgresThingModel } = require('./thing');
          let ThingModel = await getPostgresThingModel(Review.dal);
          if (!ThingModel) {
            ThingModel = await getPostgresThingModel();
          }

          if (!ThingModel) {
            debug.db('Thing model not available for joins in Review.getFeed');
          } else {
            debug.db(`Batch fetching ${thingIds.length} things for review feed...`);

            const placeholders = thingIds.map((_, index) => `$${index + 1}`).join(', ');
            const thingQuery = `
              SELECT * FROM ${ThingModel.tableName}
              WHERE id IN (${placeholders})
                AND (_old_rev_of IS NULL)
                AND (_rev_deleted IS NULL OR _rev_deleted = false)
            `;

            const thingResult = await ThingModel.dal.query(thingQuery, thingIds);
            const thingMap = new Map();

            thingResult.rows.forEach(row => {
              const thingInstance = ThingModel._createInstance(row);
              thingMap.set(thingInstance.id, thingInstance);
            });

            feedItems.forEach(review => {
              if (review.thingID && thingMap.has(review.thingID)) {
                review.thing = thingMap.get(review.thingID);
              }
            });

            debug.db(`Populated thing joins for ${thingMap.size} reviews in feed`);
          }
        }
      } catch (error) {
        debug.error('Failed to join things in Review.getFeed:', error.message);
      }
    }
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

  if (user.isSuperUser || user.isSiteModerator || user.id === this.createdBy) {
    this.userCanDelete = true;
  }

  if (user.isSuperUser || user.id === this.createdBy) {
    this.userCanEdit = true;
  }

  if (user.id === this.createdBy) {
    this.userIsAuthor = true;
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
 * @param {DataAccessLayer|null} [dal] - Optional DAL instance for testing
 */
async function getPostgresReviewModel(dal = null) {
  if (!Review || dal) {
    Review = await initializeReviewModel(dal);
  }
  return Review;
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const ReviewHandle = createAutoModelHandle('reviews', initializeReviewModel, {
  staticProperties: {
    options: reviewOptions
  }
});

module.exports = ReviewHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeReviewModel;
module.exports.initializeReviewModel = initializeReviewModel; // Backward compatibility
module.exports.getPostgresReviewModel = getPostgresReviewModel;
module.exports.ReviewError = ReviewError;
