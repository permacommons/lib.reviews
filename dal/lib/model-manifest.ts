import type { ModelSchemaField } from './model.ts';
import type { StaticMethod } from './model-initializer.ts';
import type {
  InstanceMethod,
  JsonObject,
  ModelConstructor,
  ModelInstance,
  ModelViewDefinition,
  VersionedModelConstructor,
  VersionedModelInstance,
} from './model-types.ts';

/**
 * Base relation definition type for manifest relations array.
 *
 * Either `targetTable` or `target` must be provided:
 * - `targetTable`: Explicit table name string
 * - `target`: Function returning model reference (tableName derived at runtime)
 */
export interface RelationDefinition {
  name: string;
  /** Target table name. Optional if `target` is provided (derived at runtime). */
  targetTable?: string;
  sourceKey?: string;
  targetKey?: string;
  sourceColumn?: string;
  targetColumn?: string;
  hasRevisions?: boolean;
  cardinality?: 'one' | 'many';
  through?: {
    table: string;
    sourceForeignKey?: string;
    targetForeignKey?: string;
    sourceColumn?: string;
    targetColumn?: string;
  };
  /** Lazy model reference. If provided, targetTable is derived from target().tableName */
  target?: () => unknown;
}

/**
 * Model manifest definition - declarative model configuration
 * Used by createModel() to generate properly typed model handles
 *
 * Note: Relation types are inferred via Manifest['relations'] property access,
 * not via generic parameter, enabling `as const satisfies ModelManifest` pattern.
 */
export interface ModelManifest<
  Schema extends Record<string, ModelSchemaField> = Record<string, ModelSchemaField>,
  HasRevisions extends boolean = boolean,
  StaticMethods extends Record<string, StaticMethod> = Record<never, StaticMethod>,
  InstanceMethods extends object = Record<never, InstanceMethod>,
> {
  tableName: string;
  hasRevisions: HasRevisions;
  schema: Schema;
  camelToSnake?: Record<string, string>;
  relations?: readonly RelationDefinition[];
  views?: Record<string, ModelViewDefinition<ModelInstance>>;
  staticMethods?: StaticMethods &
    ThisType<InferConstructor<ModelManifest<Schema, HasRevisions, StaticMethods, InstanceMethods>>>;
  instanceMethods?: InstanceMethods &
    ThisType<InferInstance<ModelManifest<Schema, HasRevisions, StaticMethods, InstanceMethods>>>;
}

type InstanceMethodsOf<Manifest extends ModelManifest> = Manifest extends ModelManifest<
  any,
  any,
  any,
  infer Methods
>
  ? Methods
  : Record<never, InstanceMethod>;

type StaticMethodsOf<Manifest extends ModelManifest> = Manifest extends ModelManifest<
  any,
  any,
  infer Methods,
  any
>
  ? Methods
  : Record<never, StaticMethod>;

type InferInstanceMethods<Manifest extends ModelManifest> = {
  [K in keyof InstanceMethodsOf<Manifest>]: InstanceMethodsOf<Manifest>[K];
};

type InferStaticMethods<Manifest extends ModelManifest> = {
  [K in keyof StaticMethodsOf<Manifest>]: StaticMethodsOf<Manifest>[K];
};

type InferRelationNames<Manifest extends ModelManifest> =
  Manifest['relations'] extends readonly (infer Relations)[]
    ? Relations extends { name: infer Name }
      ? Name extends string
        ? Name
        : never
      : never
    : never;

/**
 * Infer persisted data fields from the schema definition.
 */
export type InferData<Schema extends Record<string, ModelSchemaField>> = {
  -readonly [K in keyof Schema as Schema[K] extends { isVirtual: true }
    ? never
    : K]: Schema[K] extends {
    validate(value: unknown): infer T;
  }
    ? T
    : unknown;
};

/**
 * Infer TVirtual type from schema definition
 * Extracts only fields marked as virtual
 */
export type InferVirtual<Schema extends Record<string, ModelSchemaField>> = {
  -readonly [K in keyof Schema as Schema[K] extends { isVirtual: true }
    ? K
    : never]: Schema[K] extends { validate(value: unknown): infer T } ? T : unknown;
};

/**
 * Helper to get virtual fields for a manifest.
 * Exported for use in create-model.ts to ensure type consistency.
 *
 * Note: Relation field types are added via intersection pattern when defining
 * the final instance type, not inferred from the manifest. This avoids
 * circular type errors for bidirectional relations.
 */
export type ManifestVirtualFields<Manifest extends ModelManifest> = InferVirtual<
  Manifest['schema']
>;

/**
 * Infer instance type from manifest
 * Returns VersionedModelInstance if hasRevisions is true, otherwise ModelInstance
 * Includes both schema virtuals and typed relation fields.
 */
export type InferInstance<Manifest extends ModelManifest> = Manifest['hasRevisions'] extends true
  ? VersionedModelInstance<InferData<Manifest['schema']>, ManifestVirtualFields<Manifest>> &
      InferInstanceMethods<Manifest>
  : ModelInstance<InferData<Manifest['schema']>, ManifestVirtualFields<Manifest>> &
      InferInstanceMethods<Manifest>;

type CreateFromRowStatic<Manifest extends ModelManifest> = {
  createFromRow(row: JsonObject): InferInstance<Manifest>;
};

/**
 * Infer constructor type from manifest
 * Returns VersionedModelConstructor if hasRevisions is true, otherwise ModelConstructor
 */
export type InferConstructor<Manifest extends ModelManifest> = Manifest['hasRevisions'] extends true
  ? VersionedModelConstructor<
      InferData<Manifest['schema']>,
      ManifestVirtualFields<Manifest>,
      VersionedModelInstance<InferData<Manifest['schema']>, ManifestVirtualFields<Manifest>> &
        InferInstanceMethods<Manifest>,
      InferRelationNames<Manifest>
    > &
      InferStaticMethods<Manifest> &
      CreateFromRowStatic<Manifest>
  : ModelConstructor<
      InferData<Manifest['schema']>,
      ManifestVirtualFields<Manifest>,
      ModelInstance<InferData<Manifest['schema']>, ManifestVirtualFields<Manifest>> &
        InferInstanceMethods<Manifest>,
      InferRelationNames<Manifest>
    > &
      InferStaticMethods<Manifest> &
      CreateFromRowStatic<Manifest>;
