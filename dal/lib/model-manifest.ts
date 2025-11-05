import type {
  JsonObject,
  ModelConstructor,
  ModelInstance,
  VersionedModelConstructor,
  VersionedModelInstance,
} from './model-types.ts';
import type { ModelSchemaField } from './model.ts';

/**
 * Model manifest definition - declarative model configuration
 * Used by createModel() to generate properly typed model handles
 */
export interface ModelManifest {
  tableName: string;
  hasRevisions: boolean;
  // TODO: Make this more strictly typed - type library fields (StringType, DateType, etc.)
  // don't exactly match ModelSchemaField interface but are compatible at runtime
  schema: Record<string, { validate(value: unknown, fieldName?: string): unknown }>;
  camelToSnake?: Record<string, string>;
  relations?: Array<{
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
  }>;
  staticMethods?: Record<string, (...args: unknown[]) => unknown>;
  instanceMethods?: Record<string, (this: unknown, ...args: unknown[]) => unknown>;
}

/**
 * Infer TRecord type from schema definition
 * Extracts the validated types from schema field validators
 */
export type InferRecord<Schema extends Record<string, ModelSchemaField>> = {
  [K in keyof Schema]: Schema[K] extends { validate(value: unknown): infer T } ? T : unknown;
};

/**
 * Infer TVirtual type from schema definition
 * Extracts only fields marked as virtual
 */
export type InferVirtual<Schema extends Record<string, ModelSchemaField>> = {
  [K in keyof Schema as Schema[K] extends { isVirtual: true }
    ? K
    : never]: Schema[K] extends { validate(value: unknown): infer T } ? T : unknown;
};

/**
 * Infer instance type from manifest
 * Returns VersionedModelInstance if hasRevisions is true, otherwise ModelInstance
 */
export type InferInstance<Manifest extends ModelManifest> =
  Manifest['hasRevisions'] extends true
    ? VersionedModelInstance<InferRecord<Manifest['schema']>, InferVirtual<Manifest['schema']>>
    : ModelInstance<InferRecord<Manifest['schema']>, InferVirtual<Manifest['schema']>>;

/**
 * Infer constructor type from manifest
 * Returns VersionedModelConstructor if hasRevisions is true, otherwise ModelConstructor
 */
export type InferConstructor<Manifest extends ModelManifest> =
  Manifest['hasRevisions'] extends true
    ? VersionedModelConstructor<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>,
        VersionedModelInstance<InferRecord<Manifest['schema']>, InferVirtual<Manifest['schema']>>
      >
    : ModelConstructor<
        InferRecord<Manifest['schema']>,
        InferVirtual<Manifest['schema']>,
        ModelInstance<InferRecord<Manifest['schema']>, InferVirtual<Manifest['schema']>>
      >;
