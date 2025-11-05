import { randomUUID } from 'crypto';
import adapters from '../adapters/adapters.ts';
import dal from '../dal/index.ts';
import { createModelModule } from '../dal/lib/model-handle.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.ts';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import Team from './team.ts';
import Thing from './thing.ts';

type PostgresModule = typeof import('../db-postgres.ts');

type ReviewRecord = JsonObject;
type ReviewVirtual = JsonObject;
type ReviewInstance = ModelInstance<ReviewRecord, ReviewVirtual> & Record<string, any>;
type ReviewModel = ModelConstructor<ReviewRecord, ReviewVirtual, ReviewInstance> &
  Record<string, any>;

let postgresModulePromise: Promise<PostgresModule> | null = null;
async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise) postgresModulePromise = import('../db-postgres.ts');
  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { proxy: reviewHandleProxy, register: registerReviewHandle } = createModelModule<
  ReviewRecord,
  ReviewVirtual,
  ReviewInstance
>({
  tableName: 'reviews',
});

const ReviewHandle = reviewHandleProxy as ReviewModel;

const { types, mlString, revision } = dal;
const { isValid: isValidLanguage } = languages;

const reviewOptions = {
  maxTitleLength: 255,
};

interface ReviewFeedOptions {
  createdBy?: string;
  offsetDate?: Date;
  onlyTrusted?: boolean;
  thingID?: string;
  withThing?: boolean;
  withTeams?: boolean;
  withoutCreator?: string;
  limit?: number;
}

interface ReviewFeedResult {
  feedItems: unknown[];
  offsetDate?: Date;
}

interface CreateReviewOptions {
  tags?: string[];
  files?: string[];
}

let Review = null;

/**
 * Initialize the PostgreSQL Review model
 * @param dal - Optional DAL instance for testing
 */
async function initializeReviewModel(dal = null) {
  const activeDAL = dal || (await getPostgresDAL());

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping Review model initialization');
    return null;
  }

  try {
    // Create the schema with revision fields and JSONB columns
    const reviewSchema = {
      id: types.string().uuid(4),

      // CamelCase schema fields that map to snake_case database columns
      thingID: types.string().uuid(4).required(true),

      // JSONB multilingual content fields
      title: mlString.getSchema({ maxLength: reviewOptions.maxTitleLength }),
      text: mlString.getSchema(),
      html: mlString.getSchema(),

      // Relational fields
      starRating: types.number().min(1).max(5).integer().required(true),
      createdOn: types.date().required(true),
      createdBy: types.string().uuid(4).required(true),
      originalLanguage: types.string().max(4).validator(isValidLanguage),
      socialImageID: types.string().uuid(4),

      // Virtual permission fields
      userCanDelete: types.virtual().default(false),
      userCanEdit: types.virtual().default(false),
      userIsAuthor: types.virtual().default(false),
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
        socialImageID: 'social_image_id',
      },
      withRevision: true,
      staticMethods: {
        getWithData,
        create: createReview,
        validateSocialImage,
        findOrCreateThing,
        getFeed,
      },
      instanceMethods: {
        populateUserInfo,
        deleteAllRevisionsWithThing,
      },
      relations: [
        {
          name: 'thing',
          targetTable: 'things',
          sourceKey: 'thing_id',
          targetKey: 'id',
          hasRevisions: true,
          cardinality: 'one',
        },
        {
          name: 'creator',
          targetTable: 'users',
          sourceKey: 'created_by',
          targetKey: 'id',
          hasRevisions: false,
          cardinality: 'one',
        },
        {
          name: 'socialImage',
          targetTable: 'files',
          sourceKey: 'social_image_id',
          targetKey: 'id',
          hasRevisions: true,
          cardinality: 'one',
        },
        {
          name: 'teams',
          targetTable: 'teams',
          sourceKey: 'id',
          targetKey: 'id',
          hasRevisions: true,
          through: {
            table: 'review_teams',
            sourceForeignKey: 'review_id',
            targetForeignKey: 'team_id',
          },
          cardinality: 'many',
        },
      ],
    });
    Review = model;

    if (!isNew) {
      return Review;
    }

    Object.defineProperty(Review, 'options', {
      value: reviewOptions,
      writable: false,
      enumerable: true,
      configurable: false,
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
 * @param id - the unique ID to look up
 * @returns {Review} the review and associated data
 */
async function getWithData(id) {
  // Get the review with socialImage and creator relations via joins
  const joinOptions = {
    socialImage: true,
    creator: true,
  };

  const review = await Review.getNotStaleOrDeleted(id, joinOptions);

  if (!review) {
    return null;
  }

  // Manually load thing data instead of using a join because Thing.getWithData()
  // itself loads the thing's associated files (a one-to-many relation), which
  // would require more complex join logic than the simple one-to-one join support
  if (review.thingID) {
    try {
      const thing = await Thing.getWithData(review.thingID);
      if (thing) {
        review.thing = thing;
      }
    } catch (error) {
      debug.db('Failed to fetch thing for review:', error);
    }
  }

  // Manually join team data
  try {
    const teams = await _getReviewTeams(review.id);
    if (teams.length > 0) {
      review.teams = teams;
    }
  } catch (error) {
    debug.db('Failed to fetch teams for review:', error);
  }

  return review;
}

/**
 * Create and save a review and the associated Thing and Teams.
 *
 * @async
 * @param reviewObj - object containing the data to associate with this review
 * @param [options] - options for the created revision
 * @param options.tags - tags to associate with this revision
 * @param options.files - UUIDs of files to add to the Thing for this review
 * @returns {Review} the saved review
 */
async function createReview(reviewObj, { tags, files }: CreateReviewOptions = {}) {
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
        `/review/${existingResult.rows[0].id}/edit`,
      ],
    });
  }

  // Validate social image
  Review.validateSocialImage({
    socialImageID: reviewObj.socialImageID,
    newFileIDs: files,
    fileObjects: thing.files || [],
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
    tags,
  });

  try {
    // Set teams for saveAll to handle
    if (reviewObj.teams && Array.isArray(reviewObj.teams)) {
      review.teams = reviewObj.teams;
    }

    await review.saveAll({
      teams: true,
    });

    review.thing = thing;

    return review;
  } catch (error) {
    if (error instanceof ReviewError) {
      throw error;
    } else {
      throw new ReviewError({
        parentError: error,
        payload: { review },
      });
    }
  }
}

/**
 * Ensure that the social media image specified for this review is associated
 * with the review subject or in the list of newly uploaded files.
 *
 * @param [options] - Validation data
 * @param options.socialImageID - Social media image UUID
 * @param options.newFileIDs - Array of newly uploaded file IDs
 * @param options.fileObjects - Array of file objects associated with review subject
 */
function validateSocialImage({
  socialImageID = undefined,
  newFileIDs = [],
  fileObjects = [],
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
 * @param reviewObj - the data associated with the review
 * @returns {Thing} the located or created Thing
 */
async function findOrCreateThing(reviewObj) {
  // We have an existing thing to add this review to
  if (reviewObj.thing) {
    return reviewObj.thing;
  }

  // Look up existing thing by URL
  debug.db('Review.findOrCreateThing: lookup by URL', { url: reviewObj.url });
  const existingThings = await Thing.lookupByURL(reviewObj.url);
  if (existingThings.length) {
    debug.db('Review.findOrCreateThing: existing thing found', { thingID: existingThings[0].id });
    return existingThings[0];
  }

  // Create new thing
  const date = new Date();

  const thing = await Thing.createFirstRevision(
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
    tags: ['create-via-review'],
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
 * @param [options] - Feed selection criteria
 * @param options.createdBy - author to filter by
 * @param options.offsetDate - get reviews older than this date
 * @param options.onlyTrusted=false - only get reviews by trusted users
 * @param options.thingID - only get reviews of the Thing with the provided ID
 * @param options.withThing=true - join the associated Thing object
 * @param options.withTeams=true - join the associated Team objects
 * @param options.withoutCreator - exclude reviews by the user with the provided ID
 * @param options.limit=10 - how many reviews to load
 * @returns {Object} feed object with items and optional offsetDate
 */
async function getFeed({
  createdBy,
  offsetDate,
  onlyTrusted = false,
  thingID,
  withThing = true,
  withTeams = true,
  withoutCreator,
  limit = 10,
}: ReviewFeedOptions = {}): Promise<ReviewFeedResult> {
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

  if (onlyTrusted) {
    query += `
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = r.created_by
          AND u.is_trusted = true
      )`;
  }

  query += ` ORDER BY created_on DESC LIMIT $${paramIndex}`;
  params.push(limit + 1); // Get one extra to check for pagination

  // Execute query
  const result = await Review.dal.query(query, params);
  const feedItems = result.rows.slice(0, limit).map(row => Review._createInstance(row));
  const feedResult: ReviewFeedResult = { feedItems };

  // Check for pagination
  if (result.rows.length === limit + 1 && feedItems.length > 0 && limit > 0) {
    const lastVisible = feedItems[feedItems.length - 1];
    const offsetCandidate = lastVisible.createdOn || lastVisible.created_on;
    if (offsetCandidate instanceof Date) {
      feedResult.offsetDate = offsetCandidate;
    } else if (offsetCandidate) {
      feedResult.offsetDate = new Date(offsetCandidate);
    }
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
            urlName: user.display_name
              ? encodeURIComponent(user.display_name.replace(/ /g, '_'))
              : undefined,
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
          debug.db(`Batch fetching ${thingIds.length} things for review feed...`);

          const placeholders = thingIds.map((_, index) => `$${index + 1}`).join(', ');
          const thingQuery = `
            SELECT * FROM ${Thing.tableName}
            WHERE id IN (${placeholders})
              AND (_old_rev_of IS NULL)
              AND (_rev_deleted IS NULL OR _rev_deleted = false)
          `;

          const thingResult = await Thing.dal.query(thingQuery, thingIds);
          const thingMap = new Map();

          thingResult.rows.forEach(row => {
            const thingInstance = Thing._createInstance(row);
            thingMap.set(thingInstance.id, thingInstance);
          });

          feedItems.forEach(review => {
            if (review.thingID && thingMap.has(review.thingID)) {
              review.thing = thingMap.get(review.thingID);
            }
          });

          debug.db(`Populated thing joins for ${thingMap.size} reviews in feed`);
        }
      } catch (error) {
        debug.error('Failed to join things in Review.getFeed:', error.message);
      }
    }

    if (withTeams) {
      try {
        const reviewIds = feedItems.map(review => review.id).filter(Boolean);

        if (reviewIds.length > 0) {
          debug.db(`Batch fetching teams for ${reviewIds.length} reviews in feed...`);

          const reviewTeamTableName = Review.dal.schemaNamespace
            ? `${Review.dal.schemaNamespace}review_teams`
            : 'review_teams';
          const teamTableName = Review.dal.schemaNamespace
            ? `${Review.dal.schemaNamespace}teams`
            : 'teams';

          // Get all review-team associations
          const placeholders = reviewIds.map((_, index) => `$${index + 1}`).join(', ');
          const teamQuery = `
            SELECT rt.review_id, t.* FROM ${teamTableName} t
            JOIN ${reviewTeamTableName} rt ON t.id = rt.team_id
            WHERE rt.review_id IN (${placeholders})
              AND (t._old_rev_of IS NULL)
              AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
          `;

          const teamResult = await Review.dal.query(teamQuery, reviewIds);

          // Group teams by review ID
          const reviewTeamMap = new Map();
          teamResult.rows.forEach(row => {
            const reviewId = row.review_id;
            const teamInstance = Team._createInstance(row);

            if (!reviewTeamMap.has(reviewId)) {
              reviewTeamMap.set(reviewId, []);
            }
            reviewTeamMap.get(reviewId).push(teamInstance);
          });

          // Assign teams to reviews
          feedItems.forEach(review => {
            if (reviewTeamMap.has(review.id)) {
              review.teams = reviewTeamMap.get(review.id);
            }
          });

          debug.db(`Populated team joins for ${reviewTeamMap.size} reviews in feed`);
        }
      } catch (error) {
        debug.error('Failed to join teams in Review.getFeed:', error.message);
      }
    }
  }

  return feedResult;
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Populate virtual fields with permissions for a given user
 *
 * @param user - the user whose permissions to check
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
 * @param user - user initiating the action
 * @returns {Promise} promise that resolves when all content has been deleted
 * @memberof Review
 * @instance
 */
async function deleteAllRevisionsWithThing(user) {
  const p1 = this.deleteAllRevisions(user, {
    tags: ['delete-with-thing'],
  });

  // This would need proper thing relationship
  let p2 = Promise.resolve();
  if (this.thing) {
    p2 = this.thing.deleteAllRevisions(user, {
      tags: ['delete-via-review'],
    });
  }

  return Promise.all([p1, p2]);
}

// Helper functions for team associations

/**
 * Get teams associated with a review
 * @param reviewId - Review ID
 * @returns {Promise<Array>} Array of team objects
 */
async function _getReviewTeams(reviewId) {
  try {
    const reviewTeamTableName = Review.dal.schemaNamespace
      ? `${Review.dal.schemaNamespace}review_teams`
      : 'review_teams';
    const teamTableName = Review.dal.schemaNamespace
      ? `${Review.dal.schemaNamespace}teams`
      : 'teams';

    const query = `
      SELECT t.* FROM ${teamTableName} t
      JOIN ${reviewTeamTableName} rt ON t.id = rt.team_id
      WHERE rt.review_id = $1
        AND (t._old_rev_of IS NULL)
        AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
    `;

    const result = await Review.dal.query(query, [reviewId]);

    return result.rows.map(row => Team._createInstance(row));
  } catch (error) {
    debug.error('Failed to get teams for review:', error);
    return [];
  }
}

/**
 * Custom error class for review-related errors
 */
class ReviewError extends ReportedError {
  constructor(options) {
    if (
      typeof options === 'object' &&
      options.parentError instanceof Error &&
      typeof options.payload?.review === 'object'
    ) {
      const parentMessage = options.parentError.message;

      if (
        parentMessage.includes('star_rating') &&
        parentMessage.includes('greater than or equal to 1')
      ) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (
        parentMessage.includes('star_rating') &&
        parentMessage.includes('less than or equal to 5')
      ) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (parentMessage.includes('star_rating') && parentMessage.includes('integer')) {
        options.userMessage = 'invalid star rating';
        options.userMessageParams = [String(options.payload.review.star_rating)];
      } else if (
        parentMessage.includes('title') &&
        parentMessage.includes(`${Review.options.maxTitleLength}`)
      ) {
        options.userMessage = 'review title too long';
      } else if (parentMessage.includes('original_language')) {
        options.userMessage = 'invalid language';
        options.userMessageParams = [String(options.payload.review.original_language)];
      }
    }
    super(options);
  }
}

registerReviewHandle({
  initializeModel: initializeReviewModel,
  handleOptions: {
    staticProperties: {
      options: reviewOptions,
    },
  },
  additionalExports: {
    initializeReviewModel,
    ReviewError,
  },
});

export default ReviewHandle;
export { initializeReviewModel as initializeModel, initializeReviewModel, ReviewError };
