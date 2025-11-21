import { randomUUID } from 'crypto';
import adapters from '../adapters/adapters.ts';
import dal from '../dal/index.ts';
import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import reviewManifest, {
  type ReviewCreateOptions,
  type ReviewFeedOptions,
  type ReviewFeedResult,
  type ReviewInstance,
  type ReviewInstanceMethods,
  type ReviewModel,
  type ReviewStaticMethods,
  type ReviewValidateSocialImageOptions,
  reviewOptions,
} from './manifests/review.ts';
import { referenceTeam, type TeamInstance } from './manifests/team.ts';
import { referenceThing, type ThingInstance } from './manifests/thing.ts';
import { referenceUser, type UserView } from './manifests/user.ts';
import type { UserAccessContext } from './user.ts';

const Thing = referenceThing();
const User = referenceUser();

const { revision } = dal;

const reviewStaticMethods = defineStaticMethods(reviewManifest, {
  /**
   * Get a review by ID, including commonly joined data.
   *
   * @param id - Unique review identifier to look up
   * @returns The review instance populated with related data
   */
  async getWithData(this: ReviewModel, id: string) {
    const joinOptions = {
      socialImage: true,
      creator: true,
    };

    const review = (await this.getNotStaleOrDeleted(id, joinOptions)) as
      | (ReviewInstance & Record<string, any>)
      | null;

    if (!review) {
      return null;
    }

    if (review.thingID) {
      try {
        const thing = await Thing.getWithData(review.thingID);
        if (thing) {
          (review as Record<string, any>).thing = thing;
        }
      } catch (error) {
        debug.db('Failed to fetch thing for review:', error);
      }
    }

    try {
      const teams = await _getReviewTeams(review.id);
      if (teams.length > 0) {
        (review as Record<string, any>).teams = teams;
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
    this: ReviewModel,
    reviewObj: Record<string, any>,
    { tags, files }: ReviewCreateOptions = {}
  ) {
    const thing = await this.findOrCreateThing(reviewObj);

    const existingReview = await this.filterWhere({
      thingID: thing.id,
      createdBy: reviewObj.createdBy,
    }).first();

    if (existingReview) {
      throw new ReviewError({
        message: 'User has previously reviewed this subject.',
        userMessage: 'previously reviewed submission',
        userMessageParams: [`/review/${existingReview.id}`, `/review/${existingReview.id}/edit`],
      });
    }

    this.validateSocialImage({
      socialImageID: reviewObj.socialImageID,
      newFileIDs: files,
      fileObjects: (thing.files ?? []) as Array<Record<string, any>>,
    });

    if (Array.isArray(files)) {
      await thing.addFilesByIDsAndSave(files, reviewObj.createdBy);
    }

    const ReviewConstructor = this as unknown as new () => ReviewInstance & Record<string, any>;
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
        (review as Record<string, any>).teams = reviewObj.teams;
      }

      await review.saveAll({
        teams: true,
      });

      (review as Record<string, any>).thing = thing;

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
  validateSocialImage(this: ReviewModel, options: ReviewValidateSocialImageOptions = {}) {
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
  async findOrCreateThing(this: ReviewModel, reviewObj: Record<string, any>) {
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
    debug.db('Review.findOrCreateThing: created first revision', {
      provisionalThingID: thing.id,
    });

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
    this: ReviewModel,
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
    const builder = this.filterWhere({});

    if (offsetDate) {
      builder.and({ createdOn: this.ops.lt(offsetDate) });
    }

    if (thingID) {
      builder.and({ thingID });
    }

    if (withoutCreator) {
      builder.and({ createdBy: this.ops.neq(withoutCreator) });
    }

    if (createdBy) {
      builder.and({ createdBy });
    }

    if (onlyTrusted) {
      builder.whereRelated('creator', 'isTrusted', true);
    }

    const feedPage = await builder.chronologicalFeed({ cursorField: 'createdOn', limit });
    const feedItems = feedPage.rows as Array<ReviewInstance & Record<string, any>>;
    const feedResult: ReviewFeedResult = { feedItems };

    if (feedPage.hasMore) {
      feedResult.offsetDate = feedPage.nextCursor;
    }

    if (withThing || withTeams) {
      try {
        const userIds = [
          ...new Set(
            feedItems
              .map(review => review.createdBy)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          ),
        ];

        if (userIds.length > 0) {
          debug.db(`Batch fetching ${userIds.length} unique creators...`);

          const creators = await User.fetchView<UserView>('publicProfile', {
            includeSensitive: ['email'],
            configure(builder) {
              builder.whereIn('id', userIds, { cast: 'uuid[]' });
            },
          });

          const userMap = new Map<string, UserView>();
          creators.forEach(user => {
            if (typeof user.id === 'string') {
              userMap.set(user.id, user);
            }
          });

          feedItems.forEach(review => {
            const createdBy = review.createdBy;
            if (typeof createdBy === 'string' && userMap.has(createdBy)) {
              (review as Record<string, any>).creator = userMap.get(createdBy);
            }
          });

          debug.db(`Successfully populated creators for ${creators.length} users`);
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

            const things = (await Thing.filterWhere({})
              .whereIn('id', thingIds, { cast: 'uuid[]' })
              .run()) as ThingInstance[];
            const thingMap = new Map<string, ThingInstance>();

            things.forEach(thingInstance => {
              if (thingInstance.id) {
                thingMap.set(thingInstance.id, thingInstance);
              }
            });

            feedItems.forEach(review => {
              const thingID = review.thingID;
              if (typeof thingID === 'string' && thingMap.has(thingID)) {
                (review as Record<string, any>).thing = thingMap.get(thingID);
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
          const reviewIds = feedItems
            .map(review => review.id)
            .filter((id): id is string => typeof id === 'string');

          if (reviewIds.length > 0) {
            debug.db(`Batch fetching teams for ${reviewIds.length} reviews in feed...`);

            const reviewTeamMap = await this.loadManyRelated('teams', reviewIds);

            feedItems.forEach(review => {
              const reviewId = review.id;
              if (typeof reviewId === 'string' && reviewTeamMap.has(reviewId)) {
                (review as Record<string, any>).teams = reviewTeamMap.get(reviewId);
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
}) satisfies ReviewStaticMethods;

const reviewInstanceMethods = defineInstanceMethods(reviewManifest, {
  /**
   * Populate virtual permission flags relative to the provided user.
   *
   * @param user - Viewer whose permissions should be reflected
   */
  populateUserInfo(this: ReviewInstance, user: UserAccessContext | null | undefined) {
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
  async deleteAllRevisionsWithThing(this: ReviewInstance, user: Record<string, any>) {
    const revisionActor = (
      typeof user.id === 'string' ? { id: user.id } : { id: String(user.id ?? '') }
    ) as { id: string };

    const p1 = this.deleteAllRevisions(revisionActor, {
      tags: ['delete-with-thing'],
    });

    let p2: Promise<unknown> = Promise.resolve();
    const relatedThing = (this as Record<string, any>).thing as
      | (ThingInstance & Record<string, any>)
      | undefined;
    if (relatedThing && typeof relatedThing.deleteAllRevisions === 'function') {
      p2 = relatedThing.deleteAllRevisions(revisionActor, {
        tags: ['delete-via-review'],
      });
    }

    return Promise.all([p1, p2]);
  },
}) satisfies ReviewInstanceMethods;

const Review = defineModel(reviewManifest, {
  statics: {
    options: reviewOptions,
  },
  staticMethods: reviewStaticMethods,
  instanceMethods: reviewInstanceMethods,
}) as ReviewModel;

// Helper functions for team associations

/**
 * Get teams associated with a review
 * @param reviewId - Review ID
 * @returns {Promise<Array>} Array of team objects
 */
async function _getReviewTeams(reviewId: string): Promise<TeamInstance[]> {
  try {
    const reviewModel = Review as ReviewModel;
    const reviewTeamMap = await reviewModel.loadManyRelated('teams', [reviewId]);
    return (reviewTeamMap.get(reviewId) as TeamInstance[] | undefined) || [];
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
