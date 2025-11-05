export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

// TODO Phase 4: Fix type parameter usage and interface design.
// Current issues:
//   1. Type parameters are prefixed with _ (unused), preventing type inference for model fields
//   2. Index signature [key: string]: unknown allows any property, defeating type safety
//   3. Methods are optional (?) but always implemented by Model class
//   4. Should extend TRecord & TVirtual to provide autocomplete and type checking
// Target design:
//   - Split into ModelInstance (base) and VersionedModelInstance (with revision fields)
//   - Make interface extend TRecord & TVirtual for proper type inference
//   - Replace JsonObject parameters with specific option types (SaveOptions, etc.)
//   - Make core methods required, not optional
export interface ModelInstance<
  _TRecord extends JsonObject = JsonObject,
  _TVirtual extends JsonObject = JsonObject,
> {
  [key: string]: unknown;
  save?(options?: JsonObject): Promise<this>;
  delete?(options?: JsonObject): Promise<boolean>;
  newRevision?(user: unknown, options?: JsonObject): Promise<this>;
}

export interface ModelConstructor<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
> {
  new (...args: unknown[]): TInstance;
  tableName?: string;
  define?: (name: string, handler: (...args: unknown[]) => unknown) => void;
  defineRelation?: (name: string, config: JsonObject) => void;
  prototype: TInstance;
  [key: string]: unknown;
}

import type { Pool, PoolClient, QueryResult } from 'pg';

export interface DataAccessLayer {
  schemaNamespace?: string;
  connect(): Promise<this>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;
  query<TRecord extends JsonObject = JsonObject>(
    text: string,
    params?: unknown[],
    client?: Pool | PoolClient | null
  ): Promise<QueryResult<TRecord>>;
  getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TRecord, TVirtual>;
  createModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string,
    schema: JsonObject,
    options?: JsonObject
  ): ModelConstructor<TRecord, TVirtual>;
  getRegisteredModels(): Map<string, ModelConstructor>;
  getModelRegistry?(): unknown;
  pool?: Pool;
}
