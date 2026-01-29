import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import type { MultilingualString } from 'rev-dal/lib/ml-string';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { InferInstance, ModelManifest } from 'rev-dal/lib/model-manifest';
import type { ModelInstance } from 'rev-dal/lib/model-types';
import type {
  AdapterLookupData,
  AdapterLookupResult,
} from '../../adapters/abstract-backend-adapter.ts';
import languages from '../../locales/languages.ts';
import ReportedError from '../../util/reported-error.ts';
import urlUtils from '../../util/url-utils.ts';
import type { FileInstance } from './file.ts';
import type { ReviewInstance } from './review.ts';
import type { UserAccessContext } from './user.ts';

const { mlString, types } = dal;

/**
 * Entry for a single synced field, tracking its source and update state.
 */
export interface SyncEntry {
  active: boolean;
  source: string;
  updated?: Date;
}

/**
 * Fields that can be synced from adapters, derived from AdapterLookupData.
 * Excludes 'thing' which is a domain object reference, not a syncable field.
 */
export type SyncField = Exclude<keyof AdapterLookupData, 'thing'>;

/**
 * The full sync configuration object, keyed by syncable field name.
 */
export type SyncData = Partial<Record<SyncField, SyncEntry>>;

/**
 * Structured metadata stored in the JSONB `metadata` column.
 */
export interface MetadataData {
  description?: Record<string, string>;
  subtitle?: Record<string, string>;
  authors?: Array<Record<string, string>>;
}
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
  const entries = Object.entries(metadata as Partial<MetadataData>);
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

const thingManifest = {
  tableName: 'things',
  hasRevisions: true as const,
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
    urlID: types.virtual().default(function (this: ModelInstance) {
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
    description: types
      .virtual()
      .returns<MultilingualString | undefined>()
      .default(function () {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.description;
      }),
    subtitle: types
      .virtual()
      .returns<MultilingualString | undefined>()
      .default(function () {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.subtitle;
      }),
    authors: types
      .virtual()
      .returns<MultilingualString[] | undefined>()
      .default(function () {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.authors;
      }),

    // Note: relation fields (reviews, files) are typed via intersection pattern
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
  ],
} as const satisfies ModelManifest;

export type ThingRelations = { reviews?: ReviewInstance[]; files?: FileInstance[] };

type ThingInstanceBase = InferInstance<typeof thingManifest> & ThingRelations;

export type ThingInstanceMethodsMap = {
  initializeFieldsFromAdapter(adapterResult: AdapterLookupResult): void;
  populateUserInfo(user: UserAccessContext | null | undefined): void;
  populateReviewMetrics(): Promise<ThingInstanceBase & ThingInstanceMethodsMap>;
  setURLs(urls: string[]): void;
  updateActiveSyncs(userID?: string): Promise<ThingInstanceBase & ThingInstanceMethodsMap>;
  getReviewsByUser(user: UserAccessContext | null | undefined): Promise<ReviewInstance[]>;
  getAverageStarRating(): Promise<number>;
  getReviewCount(): Promise<number>;
  getSourceIDsOfActiveSyncs(): string[];
  addFile(file: FileInstance): void;
  updateSlug(
    userID: string,
    language?: string
  ): Promise<ThingInstanceBase & ThingInstanceMethodsMap>;
  addFilesByIDsAndSave(
    fileIDs: string[],
    userID?: string
  ): Promise<ThingInstanceBase & ThingInstanceMethodsMap>;
};

export type ThingInstance = ManifestInstance<typeof thingManifest, ThingInstanceMethodsMap> &
  ThingRelations;

export type ThingStaticMethodsMap = {
  lookupByURL(
    url: string,
    userID?: string | null
  ): Promise<Array<ThingInstanceBase & ThingInstanceMethodsMap>>;
  getWithData(
    id: string,
    options?: { withFiles?: boolean; withReviewMetrics?: boolean }
  ): Promise<ThingInstanceBase & ThingInstanceMethodsMap>;
  getLabel(thing: ThingLabelSource | null | undefined, language: string): string | undefined;
};
type ThingTypes = ManifestBundle<
  typeof thingManifest,
  ThingRelations,
  ThingStaticMethodsMap,
  ThingInstanceMethodsMap
>;
export type ThingInstanceMethods = ThingTypes['InstanceMethods'];
export type ThingStaticMethods = ThingTypes['StaticMethods'];
export type ThingModel = ThingTypes['Model'];

/**
 * Create a typed reference to the Thing model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceThing(): ThingModel {
  return referenceModel(thingManifest) as ThingModel;
}

export default thingManifest;
