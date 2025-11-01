import type { Pool, PoolClient, QueryResult } from 'pg';
import type { PostgresConfig } from 'config';

export type UUID = string;
export type JsonValue = unknown;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type MultilingualText = Partial<Record<LibReviews.LocaleCodeWithUndetermined, string>>;
export type MultilingualTextArray = Partial<Record<LibReviews.LocaleCodeWithUndetermined, string[]>>;
export interface MultilingualRichText {
  text?: MultilingualText;
  html?: MultilingualText;
}

export interface RevisionMetadata {
  _rev_id: UUID;
  _rev_user: UUID | null;
  _rev_date: Date;
  _rev_tags: string[] | null;
  _old_rev_of: UUID | null;
  _rev_deleted: boolean | null;
}

export interface UserRecord {
  id: UUID;
  displayName: string;
  canonicalName: string;
  email: string | null;
  password: string | null;
  userMetaID: UUID | null;
  inviteLinkCount: number;
  registrationDate: Date;
  showErrorDetails: boolean;
  isTrusted: boolean;
  isSiteModerator: boolean;
  isSuperUser: boolean;
  suppressedNotices: string[] | null;
  prefersRichTextEditor: boolean;
}

export interface UserMetaRecord extends RevisionMetadata {
  id: UUID;
  bio: MultilingualRichText | null;
  originalLanguage: LibReviews.LocaleCode | 'und' | null;
}

export interface TeamRecord extends RevisionMetadata {
  id: UUID;
  modApprovalToJoin: boolean;
  onlyModsCanBlog: boolean;
  createdBy: UUID;
  createdOn: Date;
  canonicalSlugName: string | null;
  originalLanguage: LibReviews.LocaleCode | null;
  name: MultilingualText;
  motto: MultilingualText;
  description: MultilingualRichText | null;
  rules: MultilingualRichText | null;
  confersPermissions: JsonObject | null;
}

export interface TeamJoinRequestRecord {
  id: UUID;
  teamID: UUID;
  userID: UUID;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  requestDate: Date | null;
  requestMessage: string | null;
  rejectedBy: UUID | null;
  rejectionDate: Date | null;
  rejectionMessage: string | null;
  rejectedUntil: Date | null;
}

export interface TeamSlugRecord {
  id: UUID;
  teamID: UUID;
  slug: string;
  createdOn: Date | null;
  createdBy: UUID | null;
  name: string | null;
}

export interface ThingMetadata extends JsonObject {
  description?: MultilingualRichText | null;
  subtitle?: MultilingualText | null;
  authors?: MultilingualTextArray | null;
  [key: string]: JsonValue;
}

export interface ThingRecord extends RevisionMetadata {
  id: UUID;
  urls: string[] | null;
  label: MultilingualText;
  aliases: MultilingualTextArray;
  metadata: ThingMetadata | null;
  sync: JsonObject | null;
  originalLanguage: LibReviews.LocaleCode | null;
  canonicalSlugName: string | null;
  createdOn: Date;
  createdBy: UUID;
}

export interface ThingSlugRecord {
  id: UUID;
  thingID: UUID;
  slug: string;
  createdOn: Date | null;
  createdBy: UUID | null;
  baseName: string | null;
  name: string | null;
  qualifierPart: string | null;
}

export interface FileRecord extends RevisionMetadata {
  id: UUID;
  name: string | null;
  description: MultilingualText;
  uploadedBy: UUID | null;
  uploadedOn: Date | null;
  mimeType: string | null;
  license: 'cc-0' | 'cc-by' | 'cc-by-sa' | 'fair-use' | null;
  creator: MultilingualText;
  source: MultilingualText;
  completed: boolean;
}

export interface ReviewRecord extends RevisionMetadata {
  id: UUID;
  thingID: UUID;
  title: MultilingualText;
  text: MultilingualText;
  html: MultilingualText;
  starRating: number;
  createdOn: Date;
  createdBy: UUID;
  originalLanguage: LibReviews.LocaleCode | null;
  socialImageID: UUID | null;
}

export interface BlogPostRecord extends RevisionMetadata {
  id: UUID;
  teamID: UUID | null;
  title: MultilingualText;
  text: MultilingualText;
  html: MultilingualText;
  createdOn: Date;
  createdBy: UUID;
  originalLanguage: LibReviews.LocaleCode;
}

export interface InviteLinkRecord {
  id: UUID;
  createdBy: UUID;
  createdOn: Date;
  usedBy: UUID | null;
}

export interface ModelInstance<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject> {
  dal: DataAccessLayer;
  save(options?: JsonObject): Promise<this>;
  delete(options?: JsonObject): Promise<void>;
  newRevision?(user: unknown, options?: JsonObject): Promise<this>;
  populateUserInfo?(user: unknown): Promise<void> | void;
  [key: string]: unknown;
}

export interface QueryBuilder<TRecord extends JsonObject = JsonObject> {
  filter(criteria?: Partial<TRecord>): this;
  orderBy(order: string | string[]): this;
  limit(count: number): this;
  offset(count: number): this;
  includeSensitive?(fields?: string | string[]): this;
  join?(relation: string, handler?: (builder: QueryBuilder<JsonObject>) => void): this;
  run(): Promise<TRecord[]>;
  first(): Promise<TRecord | null>;
  count(): Promise<number>;
  delete(): Promise<number>;
  [key: string]: unknown;
}

export interface ModelConstructor<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject, TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>> {
  new (data?: Partial<TRecord>): TInstance;
  tableName: string;
  dal: DataAccessLayer;
  schema?: JsonObject;
  filter(criteria?: Partial<TRecord>): QueryBuilder<TRecord>;
  query<T = TRecord>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  get(id: UUID): Promise<TInstance | null>;
  getNotStaleOrDeleted?(id: UUID): Promise<TInstance>;
  create(data: Partial<TRecord>): Promise<TInstance>;
  _createInstance?(row: TRecord): TInstance;
  [key: string]: unknown;
}

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface DataAccessLayer {
  config: Partial<PostgresConfig> & JsonObject;
  pool: Pool;
  modelRegistry: unknown;
  schemaNamespace?: string;
  connect(): Promise<DataAccessLayer>;
  disconnect(): Promise<void>;
  query<T = JsonObject>(text: string, params?: unknown[], client?: Pool | PoolClient): Promise<QueryResult<T>>;
  transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T>;
  createModel<TRecord extends JsonObject, TVirtual extends JsonObject = JsonObject>(name: string, schema: JsonObject, options?: JsonObject): ModelConstructor<TRecord, TVirtual>;
  getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(name: string): ModelConstructor<TRecord, TVirtual>;
  getRegisteredModels(): Map<string, ModelConstructor>;
  getModelRegistry(): unknown;
  migrate(path?: string): Promise<void>;
  rollback(): Promise<void>;
  isConnected(): boolean;
  getPoolStats(): PoolStats | null;
  cleanup?(options?: { dropSchema?: boolean }): Promise<void>;
  [key: string]: unknown;
}

export type DalContext = DataAccessLayer & {
  cleanup?(options?: { dropSchema?: boolean }): Promise<void>;
  schemaNamespace?: string;
};

export function createDataAccessLayer(config?: Partial<PostgresConfig>): DataAccessLayer;

export const DataAccessLayer: {
  new (config?: Partial<PostgresConfig>): DataAccessLayer;
  prototype: DataAccessLayer;
};

export const Model: ModelConstructor;

export const QueryBuilder: {
  new (...args: unknown[]): QueryBuilder<JsonObject>;
  prototype: QueryBuilder<JsonObject>;
};

export const types: Record<string, unknown>;
export const Errors: Record<string, unknown>;
export const mlString: {
  getSchema(options?: { maxLength?: number; array?: boolean }): unknown;
  resolve(lang: string, strObj: unknown): { str: string; lang: string } | undefined;
  stripHTML<T>(value: T): T;
  stripHTMLFromArray<T>(value: T[]): T[];
  validate?(value: unknown, options?: JsonObject): boolean;
};
export const revision: Record<string, unknown>;

export default createDataAccessLayer;
