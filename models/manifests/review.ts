import dal from '../../dal/index.ts';
import type { ManifestInstance, ManifestModel } from '../../dal/lib/create-model.ts';
import type { MultilingualString } from '../../dal/lib/ml-string.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferConstructor,
  InferData,
  InferInstance,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
import type { InstanceMethod, RevisionActor } from '../../dal/lib/model-types.ts';
import languages from '../../locales/languages.ts';
import type { FileInstance } from './file.ts';
import type { TeamInstance } from './team.ts';
import type { ThingInstance } from './thing.ts';
import type { UserAccessContext, UserView } from './user.ts';

const { mlString, types } = dal;
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
  fileObjects?: Array<FileInstance | { id: string }>;
}

const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),

    // CamelCase schema fields that map to snake_case database columns
    thingID: types.string().uuid(4).required(true),

    // JSONB multilingual content fields
    title: mlString.getSafeTextSchema({ maxLength: reviewOptions.maxTitleLength }),
    text: mlString.getSafeTextSchema(),
    html: mlString.getHTMLSchema(),

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

    // Note: relation fields (thing, teams, creator, socialImage) are typed via intersection pattern
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
} as const satisfies ModelManifest;

type ReviewInstanceBase = InferInstance<typeof reviewManifest>;
type ReviewModelBase = InferConstructor<typeof reviewManifest>;
type ReviewData = InferData<(typeof reviewManifest)['schema']>;

/**
 * Input for creating a review - combines schema fields with additional create-time data.
 */
export type ReviewInputObject = Partial<ReviewData> & {
  url?: string;
  thing?: ThingInstance;
  label?: MultilingualString;
  teams?: TeamInstance[];
};

export interface ReviewInstanceMethods {
  populateUserInfo(
    this: ReviewInstanceBase & ReviewInstanceMethods,
    user: UserAccessContext | null | undefined
  ): void;
  deleteAllRevisionsWithThing(
    this: ReviewInstanceBase & ReviewInstanceMethods,
    user: RevisionActor
  ): Promise<[unknown, unknown]>;
}

export interface ReviewStaticMethods {
  getWithData(
    this: ReviewModelBase & ReviewStaticMethods,
    id: string
  ): Promise<ReviewInstance | null>;
  create(
    this: ReviewModelBase & ReviewStaticMethods,
    reviewObj: ReviewInputObject,
    options?: ReviewCreateOptions
  ): Promise<ReviewInstance>;
  validateSocialImage(
    this: ReviewModelBase & ReviewStaticMethods,
    options?: ReviewValidateSocialImageOptions
  ): void;
  findOrCreateThing(
    this: ReviewModelBase & ReviewStaticMethods,
    reviewObj: ReviewInputObject
  ): Promise<ThingInstance>;
  getFeed(
    this: ReviewModelBase & ReviewStaticMethods,
    options?: ReviewFeedOptions
  ): Promise<ReviewFeedResult>;
}

// Use intersection pattern for relation types (avoids circular type errors)
// Fields are optional because they're only populated when relations are loaded
export type ReviewInstance = ManifestInstance<typeof reviewManifest, ReviewInstanceMethods> & {
  thing?: ThingInstance;
  teams?: TeamInstance[];
  creator?: UserView;
  socialImage?: FileInstance;
};

export type ReviewModel = ManifestModel<
  typeof reviewManifest,
  ReviewStaticMethods,
  ReviewInstanceMethods
> & { options: typeof reviewOptions };

/**
 * Create a typed reference to the Review model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceReview(): ReviewModel {
  return referenceModel(reviewManifest) as ReviewModel;
}

export default reviewManifest;
