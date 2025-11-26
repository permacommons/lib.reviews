import dal from '../../dal/index.ts';
import type { ManifestTypes } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';

const { types } = dal;

// Reserved slugs that must never be used without qualification
export const reservedSlugs = [
  'register',
  'actions',
  'signin',
  'login',
  'teams',
  'user',
  'new',
  'signout',
  'logout',
  'api',
  'faq',
  'static',
  'terms',
] as const;

const thingSlugManifest = {
  tableName: 'thing_slugs',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    thingID: types.string().uuid(4).required(true),
    slug: types.string().max(255).required(true),
    createdOn: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4),
    baseName: types.string().max(255),
    name: types.string().max(255),
    qualifierPart: types.string().max(255),
  },
  camelToSnake: {
    thingID: 'thing_id',
    createdOn: 'created_on',
    createdBy: 'created_by',
    baseName: 'base_name',
    qualifierPart: 'qualifier_part',
  },
} as const satisfies ModelManifest;

type ThingSlugTypes = ManifestTypes<
  typeof thingSlugManifest,
  ThingSlugStaticMethods,
  ThingSlugInstanceMethods
>;

export interface ThingSlugStaticMethods {
  getByName(this: ThingSlugTypes['Model'], name: string): Promise<ThingSlugInstance | null>;
}

export interface ThingSlugInstanceMethods {
  qualifiedSave(this: ThingSlugTypes['Instance']): Promise<ThingSlugInstance | null>;
}

export type ThingSlugInstance = ThingSlugTypes['Instance'];
export type ThingSlugModel = ThingSlugTypes['Model'];

/**
 * Create a lazy reference to the ThingSlug model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed ThingSlug model constructor
 */
export function referenceThingSlug(): ThingSlugModel {
  return referenceModel(thingSlugManifest) as ThingSlugModel;
}

export default thingSlugManifest;
