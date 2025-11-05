export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

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
