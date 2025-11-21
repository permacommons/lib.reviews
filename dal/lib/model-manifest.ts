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
 * Model manifest definition - declarative model configuration
 * Used by createModel() to generate properly typed model handles
 */
export interface ModelManifest<
  Schema extends Record<string, ModelSchemaField> = Record<string, ModelSchemaField>,
  HasRevisions extends boolean = boolean,
  StaticMethods extends Record<string, StaticMethod> = Record<never, StaticMethod>,
  InstanceMethods extends Record<string, InstanceMethod> = Record<never, InstanceMethod>,
> {
  tableName: string;
  hasRevisions: HasRevisions;
  schema: Schema;
  camelToSnake?: Record<string, string>;
  relations?: readonly {
    name: string;
    targetTable: string;
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
    [key: string]: unknown;
  }[];
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
 * Infer instance type from manifest
 * Returns VersionedModelInstance if hasRevisions is true, otherwise ModelInstance
 */
export type InferInstance<Manifest extends ModelManifest> = Manifest['hasRevisions'] extends true
  ? VersionedModelInstance<InferData<Manifest['schema']>, InferVirtual<Manifest['schema']>> &
      InferInstanceMethods<Manifest>
  : ModelInstance<InferData<Manifest['schema']>, InferVirtual<Manifest['schema']>> &
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
      InferVirtual<Manifest['schema']>,
      VersionedModelInstance<InferData<Manifest['schema']>, InferVirtual<Manifest['schema']>> &
        InferInstanceMethods<Manifest>,
      InferRelationNames<Manifest>
    > &
      InferStaticMethods<Manifest> &
      CreateFromRowStatic<Manifest>
  : ModelConstructor<
      InferData<Manifest['schema']>,
      InferVirtual<Manifest['schema']>,
      ModelInstance<InferData<Manifest['schema']>, InferVirtual<Manifest['schema']>> &
        InferInstanceMethods<Manifest>,
      InferRelationNames<Manifest>
    > &
      InferStaticMethods<Manifest> &
      CreateFromRowStatic<Manifest>;
