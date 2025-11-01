export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ModelInstance<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject
> {
  [key: string]: unknown;
  save?(options?: JsonObject): Promise<this>;
  delete?(options?: JsonObject): Promise<boolean>;
  newRevision?(user: unknown, options?: JsonObject): Promise<this>;
}

export interface ModelConstructor<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>
> {
  new (...args: unknown[]): TInstance;
  tableName?: string;
  define?: (name: string, handler: (...args: unknown[]) => unknown) => void;
  defineRelation?: (name: string, config: JsonObject) => void;
  prototype: TInstance;
  [key: string]: unknown;
}

export interface DataAccessLayer {
  schemaNamespace?: string;
  connect(): Promise<DataAccessLayer>;
  disconnect(): Promise<void>;
  migrate(): Promise<void>;
  query<T = JsonObject>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TRecord, TVirtual>;
  createModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string,
    schema: JsonObject,
    options?: JsonObject
  ): ModelConstructor<TRecord, TVirtual>;
  getRegisteredModels(): Map<string, ModelConstructor>;
  pool?: {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
  };
}
