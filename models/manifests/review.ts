import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import type { MultilingualString } from 'rev-dal/lib/ml-string';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { InferData, ModelManifest } from 'rev-dal/lib/model-manifest';
import type { InstanceMethod, RevisionActor } from 'rev-dal/lib/model-types';
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

export type ReviewRelations = {
  thing?: ThingInstance;
  teams?: TeamInstance[];
  creator?: UserView;
  socialImage?: FileInstance;
};

export type ReviewInstanceMethodsMap = {
  populateUserInfo(user: UserAccessContext | null | undefined): void;
  deleteAllRevisionsWithThing(user: RevisionActor): Promise<[unknown, unknown]>;
};
export type ReviewInstance =
  ManifestInstance<typeof reviewManifest, ReviewInstanceMethodsMap> & ReviewRelations;

export type ReviewStaticMethodsMap = {
  getWithData(id: string): Promise<ReviewInstance | null>;
  create(reviewObj: ReviewInputObject, options?: ReviewCreateOptions): Promise<ReviewInstance>;
  validateSocialImage(options?: ReviewValidateSocialImageOptions): void;
  findOrCreateThing(reviewObj: ReviewInputObject): Promise<ThingInstance>;
  getFeed(options?: ReviewFeedOptions): Promise<ReviewFeedResult>;
};
type ReviewTypes = ManifestBundle<
  typeof reviewManifest,
  ReviewRelations,
  ReviewStaticMethodsMap,
  ReviewInstanceMethodsMap
>;
export type ReviewInstanceMethods = ReviewTypes['InstanceMethods'];
export type ReviewStaticMethods = ReviewTypes['StaticMethods'];

type ReviewData = InferData<typeof reviewManifest.schema>;

/**
 * Input for creating a review - combines schema fields with additional create-time data.
 */
export type ReviewInputObject = Partial<ReviewData> & {
  url?: string;
  thing?: ThingInstance;
  label?: MultilingualString;
  teams?: TeamInstance[];
};

export type ReviewModel = ReviewTypes['Model'] & { options: typeof reviewOptions };

/**
 * Create a typed reference to the Review model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceReview(): ReviewModel {
  return referenceModel(reviewManifest) as ReviewModel;
}

export default reviewManifest;
