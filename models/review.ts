import { randomUUID } from 'crypto';
import adapters from '../adapters/adapters.ts';
import dal from '../dal/index.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import types from '../dal/lib/type.ts';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import Team from './team.ts';
import type { UserViewer } from './user.ts';

// TODO: Once we split manifest/types from runtime logic, drop this lazy import
// and go back to a direct Thing constructor import. For now it keeps TypeScript
// from chasing the cyclical manifest dependency.
async function getThingModel() {
  const module = await import('./thing.ts');
  return module.default;
}

const { mlString, revision } = dal as {
  mlString: Record<string, any>;
  revision: Record<string, any>;
};
const { isValid: isValidLanguage } = languages as {
  isValid: (code: string) => boolean;
};

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

interface ValidateSocialImageOptions {
  socialImageID?: string;
  newFileIDs?: string[];
  fileObjects?: Record<string, any>[];
}

const reviewManifest = defineModelManifest({
  tableName: 'reviews',
  hasRevisions: true,
  schema: {
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
  },
  camelToSnake: {
    thingID: 'thing_id',
    starRating: 'star_rating',
    createdOn: 'created_on',
    createdBy: 'created_by',
    originalLanguage: 'original_language',
    socialImageID: 'social_image_id',
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
  ] as const,
  staticMethods: {
    /**
     * Get a review by ID, including commonly joined data.
     *
     * @param id - Unique review identifier to look up
     * @returns The review instance populated with related data
     */
    async getWithData(this: Record<string, any>, id: string) {
      const joinOptions = {
        socialImage: true,
        creator: true,
      };

      const review = await this.getNotStaleOrDeleted(id, joinOptions);

      if (!review) {
        return null;
      }

      if (review.thingID) {
        try {
          const Thing = await getThingModel();
          const thing = await Thing.getWithData(review.thingID);
          if (thing) {
            review.thing = thing;
          }
        } catch (error) {
          debug.db('Failed to fetch thing for review:', error);
        }
      }

      try {
        const teams = await _getReviewTeams(review.id);
        if (teams.length > 0) {
          review.teams = teams;
        }
      } catch (error) {
        debug.db('Failed to fetch teams for review:', error);
      }

      return review;
    },
    /**
     * Create and save a review and the associated Thing and Teams.
     *
     * @param reviewObj - Data to associate with the new review
     * @param options - Revision metadata such as tags and files
     * @returns The persisted review instance
     */
    async create(
      this: Record<string, any>,
      reviewObj: Record<string, any>,
      { tags, files }: CreateReviewOptions = {}
    ) {
      const thing = await this.findOrCreateThing(reviewObj);

      const existingQuery = `
        SELECT id FROM ${this.tableName}
        WHERE thing_id = $1
          AND created_by = $2
          AND (_old_rev_of IS NULL)
          AND (_rev_deleted IS NULL OR _rev_deleted = false)
        LIMIT 1
      `;

      const existingResult = await this.dal.query(existingQuery, [thing.id, reviewObj.createdBy]);

      if (existingResult.rows.length > 0) {
        throw new ReviewError({
          message: 'User has previously reviewed this subject.',
          userMessage: 'previously reviewed submission',
          userMessageParams: [
            `/review/${existingResult.rows[0].id}`,
            `/review/${existingResult.rows[0].id}/edit`,
          ],
        });
      }

      this.validateSocialImage({
        socialImageID: reviewObj.socialImageID,
        newFileIDs: files,
        fileObjects: thing.files || [],
      });

      if (Array.isArray(files)) {
        await thing.addFilesByIDsAndSave(files, reviewObj.createdBy);
      }

      const ReviewConstructor = this as new () => Record<string, any>;
      const review = new ReviewConstructor();
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
        user: { id: reviewObj.createdBy },
        date: reviewObj.createdOn,
        tags,
      });

      try {
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
    },
    /**
     * Ensure the selected social image belongs to the Thing or newly uploaded files.
     *
     * @param options - Validation data for the selected social image
     */
    validateSocialImage(this: Record<string, any>, options: ValidateSocialImageOptions = {}) {
      const { socialImageID, newFileIDs = [], fileObjects = [] } = options;
      if (!socialImageID) {
        return;
      }

      let isValidFile = false;

      for (const file of fileObjects) {
        if (file.id === socialImageID) {
          isValidFile = true;
          break;
        }
      }

      if (!isValidFile) {
        for (const fileID of newFileIDs) {
          if (fileID === socialImageID) {
            isValidFile = true;
            break;
          }
        }
      }

      if (!isValidFile) {
        throw new ReviewError({ userMessage: 'invalid image selected' });
      }
    },
    /**
     * Locate the review subject (Thing) for a new review, or create one.
     *
     * @param reviewObj - Data describing the review target
     * @returns The located or newly created Thing
     */
    async findOrCreateThing(this: Record<string, any>, reviewObj: Record<string, any>) {
      const Thing = await getThingModel();

      if (reviewObj.thing) {
        return reviewObj.thing;
      }

      debug.db('Review.findOrCreateThing: lookup by URL', { url: reviewObj.url });
      const existingThings = await Thing.lookupByURL(reviewObj.url);
      if (existingThings.length) {
        debug.db('Review.findOrCreateThing: existing thing found', {
          thingID: existingThings[0].id,
        });
        return existingThings[0];
      }

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

      revision.applyRevisionMetadata(thing, {
        user: { id: reviewObj.createdBy },
        date,
        tags: ['create-via-review'],
      });

      const adapterPromises = adapters.getSupportedLookupsAsSafePromises(reviewObj.url);
      const results = await Promise.all(adapterPromises);

      const firstResult = adapters.getFirstResultWithData(results);
      if (firstResult) {
        thing.initializeFieldsFromAdapter(firstResult);
      }

      if (reviewObj.label && reviewObj.label[reviewObj.originalLanguage]) {
        thing.label = reviewObj.label;
      }

      await thing.save();

      if (thing.label) {
        await thing.updateSlug(reviewObj.createdBy, reviewObj.originalLanguage || 'en');
        if (thing._changed.size) {
          await thing.save();
        }
      }
      return thing;
    },
    /**
     * Get an ordered array of reviews, optionally filtered by various criteria.
     *
     * @param options - Feed selection criteria
     * @returns Feed items with optional pagination metadata
     */
    async getFeed(
      this: Record<string, any>,
      {
        createdBy,
        offsetDate,
        onlyTrusted = false,
        thingID,
        withThing = true,
        withTeams = true,
        withoutCreator,
        limit = 10,
      }: ReviewFeedOptions = {}
    ): Promise<ReviewFeedResult> {
      let query = `
        SELECT r.* FROM ${this.tableName} r
        WHERE (_old_rev_of IS NULL)
          AND (_rev_deleted IS NULL OR _rev_deleted = false)
      `;

      const params: Array<string | number | Date | undefined> = [];
      let paramIndex = 1;

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
      params.push(limit + 1);

      const result = await this.dal.query(query, params);
      const feedItems = result.rows
        .slice(0, limit)
        .map(row => this.createFromRow(row as Record<string, unknown>));
      const feedResult: ReviewFeedResult = { feedItems };

      if (result.rows.length === limit + 1 && feedItems.length > 0 && limit > 0) {
        const lastVisible = feedItems[feedItems.length - 1];
        const offsetCandidate = lastVisible.createdOn || (lastVisible as any).created_on;
        if (offsetCandidate instanceof Date) {
          feedResult.offsetDate = offsetCandidate;
        } else if (offsetCandidate) {
          feedResult.offsetDate = new Date(offsetCandidate);
        }
      }

      if (withThing || withTeams) {
        try {
          const userIds = [...new Set(feedItems.map(review => review.createdBy).filter(Boolean))];

          if (userIds.length > 0) {
            debug.db(`Batch fetching ${userIds.length} unique creators...`);

            const userQuery = `
              SELECT id, display_name, canonical_name, email, registration_date,
                     is_trusted, is_site_moderator, is_super_user
              FROM users
              WHERE id = ANY($1)
            `;

            const userResult = await this.dal.query(userQuery, [userIds]);

            const userMap = new Map<string, Record<string, any>>();
            userResult.rows.forEach(user => {
              const safeUser = {
                ...user,
                displayName: user.display_name,
                urlName: user.display_name
                  ? encodeURIComponent(user.display_name.replace(/ /g, '_'))
                  : undefined,
              };
              userMap.set(user.id, safeUser);
            });

            feedItems.forEach(review => {
              if (review.createdBy && userMap.has(review.createdBy)) {
                review.creator = userMap.get(review.createdBy);
              }
            });

            debug.db(`Successfully populated creators for ${userResult.rows.length} users`);
          }
        } catch (error) {
          const serializedError = error instanceof Error ? error.message : String(error);
          debug.error('Failed to batch fetch creators:', serializedError);
        }

        if (withThing) {
          try {
            const thingIds = [...new Set(feedItems.map(review => review.thingID).filter(Boolean))];

            if (thingIds.length > 0) {
              debug.db(`Batch fetching ${thingIds.length} things for review feed...`);

              const placeholders = thingIds.map((_, index) => `$${index + 1}`).join(', ');
              const Thing = await getThingModel();
              const thingQuery = `
                SELECT * FROM ${Thing.tableName}
                WHERE id IN (${placeholders})
                  AND (_old_rev_of IS NULL)
                  AND (_rev_deleted IS NULL OR _rev_deleted = false)
              `;

              const thingResult = await Thing.dal.query(thingQuery, thingIds);
              const thingMap = new Map<string, Record<string, any>>();

              thingResult.rows.forEach(row => {
                const thingInstance = new Thing(row);
                thingMap.set(thingInstance.id as string, thingInstance);
              });

              feedItems.forEach(review => {
                if (review.thingID && thingMap.has(review.thingID)) {
                  review.thing = thingMap.get(review.thingID);
                }
              });

              debug.db(`Populated thing joins for ${thingMap.size} reviews in feed`);
            }
          } catch (error) {
            const serializedError = error instanceof Error ? error.message : String(error);
            debug.error('Failed to join things in Review.getFeed:', serializedError);
          }
        }

        if (withTeams) {
          try {
            const reviewIds = feedItems.map(review => review.id).filter(Boolean);

            if (reviewIds.length > 0) {
              debug.db(`Batch fetching teams for ${reviewIds.length} reviews in feed...`);

              const dalInstance = this.dal;
              const reviewTeamTableName = dalInstance.schemaNamespace
                ? `${dalInstance.schemaNamespace}review_teams`
                : 'review_teams';
              const teamTableName = dalInstance.schemaNamespace
                ? `${dalInstance.schemaNamespace}teams`
                : 'teams';

              const placeholders = reviewIds.map((_, index) => `$${index + 1}`).join(', ');
              const teamQuery = `
                SELECT rt.review_id, t.* FROM ${teamTableName} t
                JOIN ${reviewTeamTableName} rt ON t.id = rt.team_id
                WHERE rt.review_id IN (${placeholders})
                  AND (t._old_rev_of IS NULL)
                  AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
              `;

              const teamResult = await dalInstance.query(teamQuery, reviewIds);

              const reviewTeamMap = new Map<string, Record<string, any>[]>();
              teamResult.rows.forEach(row => {
                const reviewId = row.review_id;
                const teamInstance = Team.createFromRow(row as Record<string, unknown>);

                if (!reviewTeamMap.has(reviewId)) {
                  reviewTeamMap.set(reviewId, []);
                }
                reviewTeamMap.get(reviewId)?.push(teamInstance);
              });

              feedItems.forEach(review => {
                if (reviewTeamMap.has(review.id)) {
                  review.teams = reviewTeamMap.get(review.id);
                }
              });

              debug.db(`Populated team joins for ${reviewTeamMap.size} reviews in feed`);
            }
          } catch (error) {
            const serializedError = error instanceof Error ? error.message : String(error);
            debug.error('Failed to join teams in Review.getFeed:', serializedError);
          }
        }
      }

      return feedResult;
    },
  },
  instanceMethods: {
    /**
     * Populate virtual permission flags relative to the provided user.
     *
     * @param user - Viewer whose permissions should be reflected
     */
    populateUserInfo(this: Record<string, any>, user: UserViewer | null | undefined) {
      if (!user) {
        return;
      }

      const isSuperUser = Boolean(user.isSuperUser);
      const isSiteModerator = Boolean(user.isSiteModerator);
      const isAuthor = user.id === this.createdBy;

      if (isSuperUser || isSiteModerator || isAuthor) {
        this.userCanDelete = true;
      }

      if (isSuperUser || isAuthor) {
        this.userCanEdit = true;
      }

      if (isAuthor) {
        this.userIsAuthor = true;
      }
    },
    /**
     * Delete all revisions of this review including the associated Thing.
     *
     * @param user - User initiating the deletion
     * @returns Promise that resolves once all deletions succeed
     */
    async deleteAllRevisionsWithThing(this: Record<string, any>, user: Record<string, any>) {
      const p1 = this.deleteAllRevisions(user, {
        tags: ['delete-with-thing'],
      });

      let p2 = Promise.resolve();
      if (this.thing) {
        p2 = this.thing.deleteAllRevisions(user, {
          tags: ['delete-via-review'],
        });
      }

      return Promise.all([p1, p2]);
    },
  },
});

const Review = defineModel(reviewManifest, {
  statics: {
    options: reviewOptions,
  },
});

export type ReviewInstance = InferInstance<typeof reviewManifest>;
export type ReviewModel = InferConstructor<typeof reviewManifest>;

// Helper functions for team associations

/**
 * Get teams associated with a review
 * @param reviewId - Review ID
 * @returns {Promise<Array>} Array of team objects
 */
async function _getReviewTeams(reviewId) {
  try {
    const reviewModel = Review as ReviewModel;
    const reviewTeamTableName = reviewModel.dal.schemaNamespace
      ? `${reviewModel.dal.schemaNamespace}review_teams`
      : 'review_teams';
    const teamTableName = reviewModel.dal.schemaNamespace
      ? `${reviewModel.dal.schemaNamespace}teams`
      : 'teams';

    const query = `
      SELECT t.* FROM ${teamTableName} t
      JOIN ${reviewTeamTableName} rt ON t.id = rt.team_id
      WHERE rt.review_id = $1
        AND (t._old_rev_of IS NULL)
        AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
    `;

    const result = await reviewModel.dal.query(query, [reviewId]);

    return result.rows.map(row => Team.createFromRow(row as Record<string, unknown>));
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
        parentMessage.includes(`${reviewOptions.maxTitleLength}`)
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

export default Review;
export { ReviewError };
