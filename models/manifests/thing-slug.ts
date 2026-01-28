import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';

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
  'forgot-password',
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

type ThingSlugInstanceMethodsMap = {
  qualifiedSave(): Promise<ThingSlugInstanceBase | null>;
};
type ThingSlugInstanceBase = ManifestInstance<
  typeof thingSlugManifest,
  ThingSlugInstanceMethodsMap
>;
type ThingSlugStaticMethodsMap = {
  getByName(name: string): Promise<ThingSlugInstanceBase | null>;
};
type ThingSlugTypes = ManifestBundle<
  typeof thingSlugManifest,
  Record<never, never>,
  ThingSlugStaticMethodsMap,
  ThingSlugInstanceMethodsMap
>;

export type ThingSlugInstanceMethods = ThingSlugTypes['InstanceMethods'];
export type ThingSlugStaticMethods = ThingSlugTypes['StaticMethods'];
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
