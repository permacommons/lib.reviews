import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';
import languages from '../../locales/languages.ts';
import type { ThingInstance } from './thing.ts';
import type { UserViewer } from './user.ts';

const { mlString } = dal as {
  mlString: Record<string, any>;
};
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

export const reviewOptions = {
  maxTitleLength: 255,
} as const;

export interface ReviewFeedOptions {
  createdBy?: string;
  offsetDate?: Date;
  onlyTrusted?: boolean;
  thingID?: string;
  withThing?: boolean;
  withTeams?: boolean;
  withoutCreator?: string;
  limit?: number;
}

export interface ReviewFeedResult {
  feedItems: ReviewInstance[];
  offsetDate?: Date;
}

export interface ReviewCreateOptions {
  tags?: string[];
  files?: string[];
}

export interface ReviewValidateSocialImageOptions {
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
});

type ReviewInstanceBase = InferInstance<typeof reviewManifest>;
type ReviewModelBase = InferConstructor<typeof reviewManifest>;

export interface ReviewInstanceMethods {
  populateUserInfo(
    this: ReviewInstanceBase & ReviewInstanceMethods,
    user: UserViewer | null | undefined
  ): void;
  deleteAllRevisionsWithThing(
    this: ReviewInstanceBase & ReviewInstanceMethods,
    user: Record<string, any>
  ): Promise<[unknown, unknown]>;
}

export interface ReviewStaticMethods {
  getWithData(
    this: ReviewModelBase & ReviewStaticMethods,
    id: string
  ): Promise<ReviewInstance | null>;
  create(
    this: ReviewModelBase & ReviewStaticMethods,
    reviewObj: Record<string, any>,
    options?: ReviewCreateOptions
  ): Promise<ReviewInstance>;
  validateSocialImage(
    this: ReviewModelBase & ReviewStaticMethods,
    options?: ReviewValidateSocialImageOptions
  ): void;
  findOrCreateThing(
    this: ReviewModelBase & ReviewStaticMethods,
    reviewObj: Record<string, any>
  ): Promise<ThingInstance>;
  getFeed(
    this: ReviewModelBase & ReviewStaticMethods,
    options?: ReviewFeedOptions
  ): Promise<ReviewFeedResult>;
}

export type ReviewInstance = ReviewInstanceBase & ReviewInstanceMethods;
export type ReviewModel = ReviewModelBase & ReviewStaticMethods & { options: typeof reviewOptions };

/**
 * Create a typed reference to the Review model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceReview(): ReviewModel {
  return referenceModel(reviewManifest) as ReviewModel;
}

export default reviewManifest;
