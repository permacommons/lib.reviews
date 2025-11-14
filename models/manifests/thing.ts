import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';
import languages from '../../locales/languages.ts';
import ReportedError from '../../util/reported-error.ts';
import urlUtils from '../../util/url-utils.ts';
import type { ReviewInstance } from './review.ts';
import type { UserViewer } from './user.ts';

const { mlString } = dal as unknown as {
  mlString: typeof import('../../dal/lib/ml-string.ts').default;
};
const { isValid: isValidLanguage } = languages as unknown as { isValid: (code: string) => boolean };

const metadataDescriptionSchema = mlString.getSafeTextSchema({ maxLength: 512 });
const metadataSubtitleSchema = mlString.getSafeTextSchema({ maxLength: 256 });
const metadataAuthorsSchema = types.array(mlString.getSafeTextSchema({ maxLength: 256 }));

function validateMetadata(metadata: unknown): boolean {
  if (metadata === null || metadata === undefined) {
    return true;
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Metadata must be an object');
  }

  const validFields = ['description', 'subtitle', 'authors'];
  const entries = Object.entries(metadata as Record<string, any>);
  for (const [key, value] of entries) {
    if (validFields.includes(key)) {
      if (value === null || value === undefined) {
        continue;
      }

      if (key === 'authors') {
        metadataAuthorsSchema.validate(value, 'metadata.authors');
        continue;
      }

      if (key === 'description') {
        metadataDescriptionSchema.validate(value, 'metadata.description');
        continue;
      }

      if (key === 'subtitle') {
        metadataSubtitleSchema.validate(value, 'metadata.subtitle');
      }
    }
  }

  return true;
}

function validateURL(url: string): boolean {
  if (urlUtils.validate(url)) {
    return true;
  }

  throw new ReportedError({
    message: 'Thing URL %s is not a valid URL.',
    messageParams: [url],
    userMessage: 'invalid url',
    userMessageParams: [],
  });
}

export interface ThingLabelSource extends Record<string, unknown> {
  id?: string;
  label?: unknown;
  urls?: unknown;
}

const thingManifest = defineModelManifest({
  tableName: 'things',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),

    // Array of URLs (first is primary)
    urls: types.array(types.string().validator(validateURL)),

    // JSONB multilingual fields
    label: mlString.getSafeTextSchema({ maxLength: 256 }),
    aliases: mlString.getSafeTextSchema({ maxLength: 256, array: true }),

    // Grouped metadata in JSONB for extensibility
    metadata: types.object().validator(validateMetadata),

    // Complex sync data in JSONB
    sync: types.object(),

    // CamelCase relational fields that map to snake_case database columns
    originalLanguage: types.string().max(4).validator(isValidLanguage),
    canonicalSlugName: types.string(),
    createdOn: types.date().required(true),
    createdBy: types.string().uuid(4).required(true),

    // Virtual fields for compatibility
    urlID: types.virtual().default(function (this: InferInstance<typeof thingManifest>) {
      const slugName =
        typeof this.getValue === 'function'
          ? this.getValue('canonicalSlugName')
          : this.canonicalSlugName;
      return slugName ? encodeURIComponent(String(slugName)) : this.id;
    }),

    // Permission virtual fields
    userCanDelete: types.virtual().default(false),
    userCanEdit: types.virtual().default(false),
    userCanUpload: types.virtual().default(false),
    userIsCreator: types.virtual().default(false),

    // Metrics virtual fields (populated asynchronously)
    numberOfReviews: types.virtual().default(0),
    averageStarRating: types.virtual().default(0),

    // Virtual accessors for nested metadata JSONB fields
    description: types.virtual().default(function (this: InferInstance<typeof thingManifest>) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.description;
    }),
    subtitle: types.virtual().default(function (this: InferInstance<typeof thingManifest>) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.subtitle;
    }),
    authors: types.virtual().default(function (this: InferInstance<typeof thingManifest>) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.authors;
    }),
  },
  camelToSnake: {
    originalLanguage: 'original_language',
    canonicalSlugName: 'canonical_slug_name',
    createdOn: 'created_on',
    createdBy: 'created_by',
  },
  relations: [
    {
      name: 'reviews',
      targetTable: 'reviews',
      sourceKey: 'id',
      targetKey: 'thing_id',
      hasRevisions: true,
      cardinality: 'many',
    },
    {
      name: 'files',
      targetTable: 'files',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'thing_files',
        sourceForeignKey: 'thing_id',
        targetForeignKey: 'file_id',
      },
      cardinality: 'many',
    },
  ] as const,
});

type ThingInstanceBase = InferInstance<typeof thingManifest>;
type ThingModelBase = InferConstructor<typeof thingManifest>;

export interface ThingInstanceMethods {
  initializeFieldsFromAdapter(
    this: ThingInstanceBase & ThingInstanceMethods,
    adapterResult: Record<string, any>
  ): void;
  populateUserInfo(
    this: ThingInstanceBase & ThingInstanceMethods,
    user: UserViewer | null | undefined
  ): void;
  populateReviewMetrics(this: ThingInstanceBase & ThingInstanceMethods): Promise<ThingInstance>;
  setURLs(this: ThingInstanceBase & ThingInstanceMethods, urls: string[]): void;
  updateActiveSyncs(
    this: ThingInstanceBase & ThingInstanceMethods,
    userID?: string
  ): Promise<ThingInstance>;
  getReviewsByUser(
    this: ThingInstanceBase & ThingInstanceMethods,
    user: UserViewer | null | undefined
  ): Promise<ReviewInstance[]>;
  getAverageStarRating(this: ThingInstanceBase & ThingInstanceMethods): Promise<number>;
  getReviewCount(this: ThingInstanceBase & ThingInstanceMethods): Promise<number>;
  addFile(this: ThingInstanceBase & ThingInstanceMethods, file: Record<string, any>): void;
  updateSlug(
    this: ThingInstanceBase & ThingInstanceMethods,
    userID: string,
    language?: string
  ): Promise<ThingInstance>;
  addFilesByIDsAndSave(
    this: ThingInstanceBase & ThingInstanceMethods,
    fileIDs: string[],
    userID?: string
  ): Promise<ThingInstance>;
}

export interface ThingStaticMethods {
  lookupByURL(
    this: ThingModelBase & ThingStaticMethods,
    url: string,
    userID?: string | null
  ): Promise<ThingInstance[]>;
  getWithData(
    this: ThingModelBase & ThingStaticMethods,
    id: string,
    options?: { withFiles?: boolean; withReviewMetrics?: boolean }
  ): Promise<ThingInstance>;
  getLabel(
    this: ThingModelBase & ThingStaticMethods,
    thing: ThingLabelSource | null | undefined,
    language: string
  ): string | undefined;
}

export type ThingInstance = ThingInstanceBase & ThingInstanceMethods;
export type ThingModel = ThingModelBase & ThingStaticMethods;

/**
 * Create a typed reference to the Thing model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceThing(): ThingModel {
  return referenceModel(thingManifest) as ThingModel;
}

export default thingManifest;
