import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

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

const thingSlugManifest = defineModelManifest({
  tableName: 'thing_slugs',
  hasRevisions: false,
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
} as const);

type ThingSlugInstanceBase = InferInstance<typeof thingSlugManifest>;
type ThingSlugModelBase = InferConstructor<typeof thingSlugManifest>;

export interface ThingSlugStaticMethods {
  getByName(
    this: ThingSlugModelBase & ThingSlugStaticMethods,
    name: string
  ): Promise<(ThingSlugInstanceBase & ThingSlugInstanceMethods) | null>;
}

export interface ThingSlugInstanceMethods {
  qualifiedSave(
    this: ThingSlugInstanceBase & ThingSlugInstanceMethods
  ): Promise<(ThingSlugInstanceBase & ThingSlugInstanceMethods) | null>;
}

export type ThingSlugInstance = ThingSlugInstanceBase & ThingSlugInstanceMethods;
export type ThingSlugModel = ThingSlugModelBase & ThingSlugStaticMethods;

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
