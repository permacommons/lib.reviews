export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

// Base model instance interface
// Now uses TRecord and TVirtual (no longer prefixed with _) for proper type inference
// The index signature is kept for backward compatibility with existing models
// TODO: Remove index signature and make methods required once all models migrated to manifest format
export interface ModelInstance<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
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

// Versioned model instance - for models with revision tracking enabled
// Extends base ModelInstance with revision-specific fields and methods
export interface VersionedModelInstance<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> extends ModelInstance<TRecord, TVirtual> {
  // Revision metadata fields
  _revID?: string;
  _revUser?: string;
  _revDate?: Date;
  _revTags?: string[];
  _revDeleted?: boolean;
  _oldRevOf?: string;

  // Revision methods
  newRevision(user: unknown, options?: { tags?: string[]; date?: Date }): Promise<this>;
  deleteAllRevisions?(): Promise<void>;
}

// Versioned model constructor - for models with revision tracking enabled
// Extends base ModelConstructor with revision-specific static methods
export interface VersionedModelConstructor<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends VersionedModelInstance<TRecord, TVirtual> = VersionedModelInstance<TRecord, TVirtual>,
> extends ModelConstructor<TRecord, TVirtual, TInstance> {
  // Additional static methods for versioned models
  createFirstRevision?(user: unknown, options?: JsonObject): Promise<TInstance>;
  getNotStaleOrDeleted?(id: string, joinOptions?: JsonObject): Promise<TInstance>;
  filterNotStaleOrDeleted?(): unknown; // Returns QueryBuilder
  getMultipleNotStaleOrDeleted?(ids: string[]): unknown; // Returns QueryBuilder
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
