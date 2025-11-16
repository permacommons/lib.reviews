import type { Pool, PoolClient, QueryResult } from 'pg';
import type { ModelSchemaField } from './model.ts';

export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface FilterWhereOperator<K extends PropertyKey, TValue> {
  readonly __allowedKeys: K;
  readonly value: TValue;
}

/**
 * Result of a chronological feed query.
 */
export interface ChronologicalFeedPage<CursorValue, TInstance> {
  rows: TInstance[];
  hasMore: boolean;
  nextCursor?: CursorValue;
}

/**
 * Options for chronological feed pagination on date-backed fields.
 */
export interface ChronologicalFeedOptions<
  TData extends JsonObject,
  K extends Extract<DateKeys<TData>, string>,
> {
  /**
   * Date-backed manifest key to use as the cursor (camelCase).
   */
  cursorField: K;
  /**
   * Exclusive cursor value returned by the previous page (Date).
   */
  cursor?: NonNullable<TData[K]>;
  /**
   * Sort direction; defaults to DESC for newest-first feeds.
   */
  direction?: 'ASC' | 'DESC';
  /**
   * Page size; defaults to 10.
   */
  limit?: number;
}

type OperatorResultForKey<TOps, K extends PropertyKey> = {
  [P in keyof TOps]: TOps[P] extends (
    ...args: unknown[]
  ) => FilterWhereOperator<infer Keys, infer TValue>
    ? K extends Keys
      ? FilterWhereOperator<K, TValue>
      : never
    : never;
}[keyof TOps];

export type FilterWhereLiteral<TRecord extends JsonObject, TOps> = Partial<{
  [K in keyof TRecord]: TRecord[K] | OperatorResultForKey<TOps, K & PropertyKey>;
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
export interface ModelInstanceCore<TData extends JsonObject, TVirtual extends JsonObject> {
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

type ComparablePrimitive = string | number | bigint | Date;

type ComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends ComparablePrimitive ? K : never;
}[keyof T];

export type DateKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Date ? K : never;
}[keyof T];

export type NumericKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends number | bigint ? K : never;
}[keyof T];

type EqualityComparablePrimitive = string | number | bigint | boolean | Date;

type EqualityComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends EqualityComparablePrimitive ? K : never;
}[keyof T];

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];

type JsonObjectKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends JsonObject ? K : never;
}[keyof T];

type NonEmptyArray<T> = readonly [T, ...T[]] | [T, ...T[]];

/**
 * Helper bag exposed as `Model.ops`. Call helpers at the point where you build
 * a predicate literal so TypeScript can associate the result with the
 * corresponding field; caching helper *results* widens their allowed keys.
 */
export interface FilterWhereOperators<TRecord extends JsonObject> {
  neq<K extends keyof TRecord>(value: TRecord[K]): FilterWhereOperator<K, TRecord[K]>;
  lt<K extends ComparableKeys<TRecord>>(
    value: NonNullable<TRecord[K]>
  ): FilterWhereOperator<K, NonNullable<TRecord[K]>>;
  lte<K extends ComparableKeys<TRecord>>(
    value: NonNullable<TRecord[K]>
  ): FilterWhereOperator<K, NonNullable<TRecord[K]>>;
  gt<K extends ComparableKeys<TRecord>>(
    value: NonNullable<TRecord[K]>
  ): FilterWhereOperator<K, NonNullable<TRecord[K]>>;
  gte<K extends ComparableKeys<TRecord>>(
    value: NonNullable<TRecord[K]>
  ): FilterWhereOperator<K, NonNullable<TRecord[K]>>;
  containsAll<K extends StringArrayKeys<TRecord>>(
    value: string | readonly string[] | string[]
  ): FilterWhereOperator<K, TRecord[K]>;
  containsAny<K extends StringArrayKeys<TRecord>>(
    value: string | readonly string[] | string[]
  ): FilterWhereOperator<K, TRecord[K]>;
  in<K extends EqualityComparableKeys<TRecord>, TValue extends TRecord[K]>(
    values: NonEmptyArray<TValue>,
    options?: { cast?: string }
  ): FilterWhereOperator<K, TValue[]>;
  not<K extends BooleanKeys<TRecord>>(): FilterWhereOperator<K, true>;
  between<K extends ComparableKeys<TRecord>>(
    lower: NonNullable<TRecord[K]>,
    upper: NonNullable<TRecord[K]>,
    options?: {
      leftBound?: 'open' | 'closed';
      rightBound?: 'open' | 'closed';
    }
  ): FilterWhereOperator<
    K,
    {
      lower: NonNullable<TRecord[K]>;
      upper: NonNullable<TRecord[K]>;
      options: {
        leftBound: 'open' | 'closed';
        rightBound: 'open' | 'closed';
      };
    }
  >;
  notBetween<K extends ComparableKeys<TRecord>>(
    lower: NonNullable<TRecord[K]>,
    upper: NonNullable<TRecord[K]>,
    options?: {
      leftBound?: 'open' | 'closed';
      rightBound?: 'open' | 'closed';
    }
  ): FilterWhereOperator<
    K,
    {
      lower: NonNullable<TRecord[K]>;
      upper: NonNullable<TRecord[K]>;
      options: {
        leftBound: 'open' | 'closed';
        rightBound: 'open' | 'closed';
      };
    }
  >;
  jsonContains<K extends JsonObjectKeys<TRecord>>(
    value: JsonObject
  ): FilterWhereOperator<K, JsonObject>;
}

/**
 * Extension of {@link ModelInstance} used by revision-enabled models.
 * Adds revision metadata properties plus helpers such as `newRevision`.
 */
type RevisionFieldMap = {
  _revID?: string;
  _revUser?: string;
  _revDate?: Date;
  _revTags?: string[];
  _revDeleted?: boolean;
  _oldRevOf?: string | null;
};

export type VersionedModelInstance<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
> = ModelInstance<TData, TVirtual> &
  RevisionFieldMap & {
    newRevision(
      user: RevisionActor | null,
      options?: RevisionMetadata
    ): Promise<VersionedModelInstance<TData, TVirtual>>;
    deleteAllRevisions(
      user?: RevisionActor | null,
      options?: RevisionMetadata
    ): Promise<VersionedModelInstance<TData, TVirtual>>;
  };

export type RevisionDataRecord = JsonObject & RevisionFieldMap;

export type InstanceMethod<TInstance extends ModelInstance = ModelInstance> = (
  this: TInstance,
  ...args: unknown[]
) => unknown;

export type FilterWhereJoinSpec<TRelations extends string> = Partial<
  Record<TRelations, boolean | JsonObject>
>;

export type ModelViewBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
> = FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations> &
  ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;

export interface ModelViewDefinition<
  TInstance extends ModelInstance = ModelInstance,
  TView extends JsonObject = JsonObject,
> {
  description?: string;
  project(instance: TInstance): TView;
}

export interface ModelViewFetchOptions<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
> {
  includeSensitive?: Extract<keyof TData, string>[];
  configure?: (builder: ModelViewBuilder<TData, TVirtual, TInstance, TRelations>) => void;
}

export interface ModelQueryBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
> extends PromiseLike<TInstance[]> {
  run(): Promise<TInstance[]>;
  first(): Promise<TInstance | null>;
  includeSensitive(
    fields: string | string[]
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  getJoin(
    joinSpec: FilterWhereJoinSpec<TRelations>
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  orderBy(
    field: string,
    direction?: 'ASC' | 'DESC'
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  limit(count: number): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  between(
    startDate: Date,
    endDate: Date,
    options?: JsonObject
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  contains(
    field: string,
    value: unknown
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  delete(): Promise<number>;
  deleteById(id: string): Promise<number>;
  count(): Promise<number>;
  average(field: string): Promise<number | null>;
  [key: string]: unknown;
}

/**
 * Query builder with typed predicates, revision guards, and helpers.
 */
export interface FilterWhereQueryBuilder<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
> extends PromiseLike<TInstance[]> {
  and(
    criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  or(
    criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  includeDeleted(): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  includeStale(): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  includeSensitive(
    fields: string | string[]
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  orderBy(
    field: Extract<keyof TData, string>,
    direction?: 'ASC' | 'DESC'
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  increment<K extends Extract<NumericKeys<TData>, string>, R extends Extract<keyof TData, string> = K>(
    field: K,
    options?: { by?: number; returning?: R[] }
  ): Promise<{ rowCount: number; rows: Array<Pick<TData, R>> }>;
  decrement<K extends Extract<NumericKeys<TData>, string>, R extends Extract<keyof TData, string> = K>(
    field: K,
    options?: { by?: number; returning?: R[] }
  ): Promise<{ rowCount: number; rows: Array<Pick<TData, R>> }>;
  limit(count: number): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  sample(count?: number): Promise<TInstance[]>;
  offset(count: number): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  /**
   * Include related records. Use `true` for inline (single-row) joins and an
   * object (e.g., `{}`) to trigger the batch loader that hydrates arrays.
   */
  getJoin(
    joinSpec: FilterWhereJoinSpec<TRelations>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  whereRelated(
    relation: TRelations,
    field: string,
    value: unknown,
    operator?: string
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  whereIn(
    field: Extract<keyof TData, string>,
    values: unknown[],
    options?: { cast?: string }
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  revisionData(
    criteria: FilterWhereLiteral<RevisionDataRecord, FilterWhereOperators<RevisionDataRecord>>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  run(): Promise<TInstance[]>;
  first(): Promise<TInstance | null>;
  count(): Promise<number>;
  average(field: Extract<keyof TData, string>): Promise<number | null>;
  delete(): Promise<number>;
  deleteById(id: string): Promise<number>;
  chronologicalFeed<K extends Extract<DateKeys<TData>, string>>(
    options: ChronologicalFeedOptions<TData, K>
  ): Promise<ChronologicalFeedPage<NonNullable<TData[K]>, TInstance>>;
}

/**
 * Runtime constructor exported by each manifest. It exposes the DAL's static
 * helpers (`create`, `get`, `filterWhere`, etc.) while producing instances typed as
 * {@link ModelInstance}. Individual models extend this interface with their
 * own static methods through `ThisType` in the manifest definition.
 */
export interface ModelConstructor<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TData, TVirtual> = ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
> {
  new (data?: Partial<TData & TVirtual>): TInstance;
  tableName: string;
  schema: Record<string, ModelSchemaField>;
  dal: DataAccessLayer;
  prototype: TInstance;

  createFromRow(row: JsonObject): TInstance;

  get(id: string, options?: GetOptions): Promise<TInstance>;
  getAll(...ids: string[]): Promise<TInstance[]>;
  filterWhere(
    criteria: FilterWhereLiteral<TData, FilterWhereOperators<TData>>
  ): FilterWhereQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  create(data: Partial<TData>, options?: JsonObject): Promise<TInstance>;
  update(id: string, data: Partial<TData>): Promise<TInstance>;
  delete(id: string): Promise<boolean>;

  orderBy(
    field: string,
    direction?: 'ASC' | 'DESC'
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  limit(count: number): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  /**
   * Attach related records defined in the manifest.
   *
   * Passing `true` joins the related table inline (best for one-to-one relations)
   * while supplying an object (even `{}`) switches to the batch loader that
   * hydrates `many` relations via a follow-up query. Use the object form whenever
   * the relation should populate an array.
   */
  getJoin(
    joinSpec: FilterWhereJoinSpec<TRelations>
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  between(
    startDate: Date,
    endDate: Date,
    options?: JsonObject
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  contains(
    field: string,
    value: unknown
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;
  getMultipleNotStaleOrDeleted(
    ids: string[]
  ): ModelQueryBuilder<TData, TVirtual, TInstance, TRelations>;

  define(name: string, handler: InstanceMethod<TInstance>): void;
  defineRelation(name: string, config: JsonObject): void;
  defineView<TView extends JsonObject = JsonObject>(
    name: string,
    definition: ModelViewDefinition<TInstance, TView>
  ): void;

  readonly ops: FilterWhereOperators<TData>;
  getView<TView extends JsonObject = JsonObject>(
    name: string
  ): ModelViewDefinition<TInstance, TView> | null;
  fetchView<TView extends JsonObject = JsonObject>(
    name: string,
    options?: ModelViewFetchOptions<TData, TVirtual, TInstance, TRelations>
  ): Promise<TView[]>;

  [key: string]: unknown;
}

export interface VersionedModelConstructor<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends VersionedModelInstance<TData, TVirtual> = VersionedModelInstance<
    TData,
    TVirtual
  >,
  TRelations extends string = string,
> extends ModelConstructor<TData, TVirtual, TInstance, TRelations> {
  createFirstRevision(user: RevisionActor, options?: RevisionMetadata): Promise<TInstance>;
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
  getModel<
    TData extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject,
    TRelations extends string = string,
  >(name: string): ModelConstructor<TData, TVirtual, ModelInstance<TData, TVirtual>, TRelations>;
  createModel<TData extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string,
    schema: Record<string, ModelSchemaField>,
    options?: JsonObject
  ): ModelConstructor<TData, TVirtual>;
  getRegisteredModels(): Map<string, ModelConstructor>;
  getModelRegistry?(): unknown;
  pool?: Pool;
}
