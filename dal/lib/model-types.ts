import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ModelSchemaField } from './model.ts';

export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface FilterWhereOperator<
  K extends PropertyKey,
  TValue,
> {
  readonly __allowedKeys: K;
  readonly value: TValue;
}

type OperatorResultForKey<
  TOps,
  K extends PropertyKey,
> = {
  [P in keyof TOps]: TOps[P] extends (...args: unknown[]) => FilterWhereOperator<infer Keys, infer TValue>
    ? K extends Keys
      ? FilterWhereOperator<K, TValue>
      : never
    : never;
}[keyof TOps];

export type FilterWhereLiteral<
  TRecord extends JsonObject,
  TOps,
> = Partial<{
  [K in keyof TRecord]:
    | TRecord[K]
    | OperatorResultForKey<TOps, K & PropertyKey>;
}>;

export interface TransactionOptions {
  transaction?: Pool | PoolClient | null;
}

export interface SaveOptions extends TransactionOptions {
  skipValidation?: boolean;
  includeSensitive?: string[];
}

export interface DeleteOptions extends TransactionOptions {
  soft?: boolean;
}

export interface RevisionMetadata {
  tags?: string[];
  date?: Date;
}

export interface RevisionActor {
  id: string;
}

export interface GetOptions extends JsonObject {
  includeSensitive?: string[];
}

/**
 * Core behaviour shared by every model instance irrespective of its schema.
 * This mirrors the public surface area exposed by the DAL: change tracking,
 * persistence helpers, and the value accessors that respect camel↔snake
 * mappings. Model authors rarely reference this directly—use
 * {@link ModelInstance} instead, which intersects these behaviours with the
 * inferred data fields.
 */
export interface ModelInstanceCore<
  TData extends JsonObject,
  TVirtual extends JsonObject,
> {
  _data: Record<string, unknown>;
  _changed: Set<string>;
  _isNew: boolean;
  _originalData: Record<string, unknown>;

  save(options?: SaveOptions): Promise<ModelInstance<TData, TVirtual>>;
  saveAll(joinOptions?: JsonObject): Promise<ModelInstance<TData, TVirtual>>;
  delete(options?: DeleteOptions): Promise<boolean>;
  getValue<K extends keyof (TData & TVirtual)>(key: K): (TData & TVirtual)[K];
  setValue<K extends keyof (TData & TVirtual)>(key: K, value: (TData & TVirtual)[K]): void;
  generateVirtualValues(): void;

  [key: string]: unknown;
}

/**
 * Concrete instance shape exported to application code. Combines the stored
 * fields inferred from the manifest (`TData`), any virtual/computed fields
 * (`TVirtual`), and the shared DAL behaviours defined in
 * {@link ModelInstanceCore}.
 */
export type ModelInstance<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> = TData & TVirtual & ModelInstanceCore<TData, TVirtual>;

type ExtractArray<T> = Extract<T, readonly unknown[] | unknown[]>;

type ArrayElement<T> = ExtractArray<T> extends readonly (infer U)[]
  ? U
  : ExtractArray<T> extends (infer U)[]
    ? U
    : never;

type StringArrayKeys<T> = {
  [K in keyof T]-?: ExtractArray<T[K]> extends never
    ? never
    : ArrayElement<T[K]> extends string
      ? K
      : never;
}[keyof T];

/**
 * Helper bag exposed as `Model.ops`. Call helpers at the point where you build
 * a predicate literal so TypeScript can associate the result with the
 * corresponding field; caching helper *results* widens their allowed keys.
 */
export interface FilterWhereOperators<TRecord extends JsonObject> {
  neq<K extends keyof TRecord>(value: TRecord[K]): FilterWhereOperator<K, TRecord[K]>;
  contains<K extends StringArrayKeys<TRecord>>(
    value: string | readonly string[] | string[]
  ): FilterWhereOperator<K, TRecord[K]>;
}

/**
 * Extension of {@link ModelInstance} used by revision-enabled models.
 * Adds revision metadata properties plus helpers such as `newRevision`.
 */
export type VersionedModelInstance<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> = ModelInstance<TData, TVirtual> & {
  _revID?: string;
  _revUser?: string;
  _revDate?: Date;
  _revTags?: string[];
  _revDeleted?: boolean;
  _oldRevOf?: string;

  newRevision(
    user: RevisionActor | null,
    options?: RevisionMetadata
  ): Promise<VersionedModelInstance<TData, TVirtual>>;
  deleteAllRevisions(
    user?: RevisionActor | null,
    options?: RevisionMetadata
  ): Promise<VersionedModelInstance<TData, TVirtual>>;
};

export type InstanceMethod<TInstance extends ModelInstance = ModelInstance> = (
  this: TInstance,
  ...args: unknown[]
) => unknown;

export interface ModelQueryBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
> extends PromiseLike<TInstance[]> {
  run(): Promise<TInstance[]>;
  first(): Promise<TInstance | null>;
  includeSensitive(
    fields: string | string[]
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  filter(
    criteria: Partial<TData> | ((row: unknown) => unknown)
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  filterNotStaleOrDeleted(): ModelQueryBuilder<TData, TVirtual, TInstance>;
  getJoin(joinSpec: JsonObject): ModelQueryBuilder<TData, TVirtual, TInstance>;
  orderBy(
    field: string,
    direction?: 'ASC' | 'DESC'
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  limit(count: number): ModelQueryBuilder<TData, TVirtual, TInstance>;
  between(
    startDate: Date,
    endDate: Date,
    options?: JsonObject
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  contains(
    field: string,
    value: unknown
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  delete(): Promise<number>;
  deleteById(id: string): Promise<number>;
  count(): Promise<number>;
  [key: string]: unknown;
}

export interface FilterWhereQueryBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
> extends PromiseLike<TInstance[]> {
  and(criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>): FilterWhereQueryBuilder<
    TData,
    TVirtual,
    TInstance
  >;
  or(criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>): FilterWhereQueryBuilder<
    TData,
    TVirtual,
    TInstance
  >;
  includeDeleted(): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  includeStale(): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  includeSensitive(fields: string | string[]): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  orderBy(
    field: string,
    direction?: 'ASC' | 'DESC'
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  limit(count: number): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  offset(count: number): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  getJoin(joinSpec: JsonObject): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  whereIn(
    field: string,
    values: unknown[],
    options?: { cast?: string }
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  run(): Promise<TInstance[]>;
  first(): Promise<TInstance | null>;
  count(): Promise<number>;
  delete(): Promise<number>;
  deleteById(id: string): Promise<number>;
}

/**
 * Runtime constructor exported by each manifest. It exposes the DAL's static
 * helpers (`create`, `get`, `filter`, etc.) while producing instances typed as
 * {@link ModelInstance}. Individual models extend this interface with their
 * own static methods through `ThisType` in the manifest definition.
 */
export interface ModelConstructor<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TData, TVirtual> = ModelInstance<TData, TVirtual>,
> {
  new (data?: Partial<TData & TVirtual>): TInstance;
  tableName: string;
  schema: Record<string, ModelSchemaField>;
  dal: DataAccessLayer;
  prototype: TInstance;

  get(id: string, options?: GetOptions): Promise<TInstance>;
  getAll(...ids: string[]): Promise<TInstance[]>;
  filter(
    criteria: Partial<TData> | ((row: unknown) => unknown)
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  filterWhere(
    criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance>;
  create(data: Partial<TData>, options?: JsonObject): Promise<TInstance>;
  update(id: string, data: Partial<TData>): Promise<TInstance>;
  delete(id: string): Promise<boolean>;

  orderBy(
    field: string,
    direction?: 'ASC' | 'DESC'
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  limit(count: number): ModelQueryBuilder<TData, TVirtual, TInstance>;
  getJoin(joinSpec: JsonObject): ModelQueryBuilder<TData, TVirtual, TInstance>;
  between(
    startDate: Date,
    endDate: Date,
    options?: JsonObject
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  contains(
    field: string,
    value: unknown
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;
  filterNotStaleOrDeleted(): ModelQueryBuilder<TData, TVirtual, TInstance>;
  getMultipleNotStaleOrDeleted(
    ids: string[]
  ): ModelQueryBuilder<TData, TVirtual, TInstance>;

  define(name: string, handler: InstanceMethod<TInstance>): void;
  defineRelation(name: string, config: JsonObject): void;

  readonly ops: FilterWhereOperators<TData>;

  [key: string]: unknown;
}

export interface VersionedModelConstructor<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends VersionedModelInstance<TData, TVirtual> = VersionedModelInstance<TData, TVirtual>,
> extends ModelConstructor<TData, TVirtual, TInstance> {
  createFirstRevision(
    user: RevisionActor,
    options?: RevisionMetadata
  ): Promise<TInstance>;
  getNotStaleOrDeleted(id: string, joinOptions?: JsonObject): Promise<TInstance>;
}

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
  getModel<TData extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TData, TVirtual>;
  createModel<
    TData extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject,
  >(
    name: string,
    schema: Record<string, ModelSchemaField>,
    options?: JsonObject
  ): ModelConstructor<TData, TVirtual>;
  getRegisteredModels(): Map<string, ModelConstructor>;
  getModelRegistry?(): unknown;
  pool?: Pool;
}
