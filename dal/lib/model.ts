import { DocumentNotFound, convertPostgreSQLError } from './errors.ts';
import QueryBuilder from './query-builder.ts';
import revision from './revision.ts';
import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance
} from './model-types.ts';
import type { ModelConstructorLike } from './revision.ts';

export interface ModelSchemaField<TValue = unknown> extends JsonObject {
  validate(value: unknown, fieldName?: string): TValue;
  isVirtual?: boolean;
  isSensitive?: boolean;
  hasDefault?: boolean;
  defaultValue?: TValue | (() => TValue);
  getDefault?: () => TValue;
}

type GetOptions = JsonObject & {
  includeSensitive?: string[];
};

export type ModelSchema<
  TRecord extends JsonObject,
  TVirtual extends JsonObject
> = Record<string, ModelSchemaField<TRecord[keyof TRecord] | TVirtual[keyof TVirtual] | unknown>>;

export interface ThroughRelationConfig extends JsonObject {
  table: string;
  sourceColumn: string;
  targetColumn: string;
  sourceCondition?: unknown;
  targetCondition?: unknown;
}

export interface NormalizedRelationConfig extends JsonObject {
  targetTable: string;
  targetModelKey: string;
  sourceColumn: string;
  targetColumn: string;
  hasRevisions: boolean;
  cardinality: 'one' | 'many';
  isArray: boolean;
  through: ThroughRelationConfig | null;
  joinType: 'through' | 'direct';
  condition: unknown;
}

type RevisionHandlerName = 'newRevision' | 'deleteAllRevisions';

type RevisionHandlerMap<TInstance extends ModelInstance> = Partial<Record<RevisionHandlerName, (this: TInstance, ...args: unknown[]) => unknown>>;


/**
 * Base Model class for PostgreSQL DAL
 *
 * Provides CRUD operations, virtual fields, and query building functionality.
 */

/**
 * Deep equality comparison for detecting actual changes in validated values
 * @param a - First value
 * @param b - Second value
 * @returns True if values are deeply equal
 * @private
 */
function deepEqual(a: unknown, b: unknown): boolean {
  // Strict equality check (handles primitives, null, undefined, same reference)
  if (a === b) return true;

  // Different types or one is null/undefined
  if (a == null || b == null || typeof a !== typeof b) return false;

  // Date comparison
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Array comparison
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Object comparison
  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key) || !deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  // Other types (functions, symbols, etc.) - use strict equality
  return false;
}

/**
 * Deep clone for tracking original values of JSONB fields
 * @param value - Value to clone
 * @returns Cloned value
 * @private
 */
function deepClone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map(item => deepClone(item)) as unknown as T;
  if (typeof value === 'object') {
    const cloned: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        cloned[key] = deepClone((value as Record<string, unknown>)[key]);
      }
    }
    return cloned as unknown as T;
  }
  return value;
}

/**
 * Base Model class
 */
class Model<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject
> implements ModelInstance<TRecord, TVirtual> {
  [key: string]: unknown;
  protected static _fieldMappings: Map<string, string> = new Map();
  protected static _relations: Map<string, NormalizedRelationConfig> = new Map();
  protected static _revisionHandlers?: RevisionHandlerMap<Model<JsonObject, JsonObject>>;

  static schema: ModelSchema<JsonObject, JsonObject>;
  static tableName: string;
  static options: JsonObject;
  static dal: DataAccessLayer;

  public _data: Record<string, unknown>;
  protected _virtualFields: Partial<TVirtual> & JsonObject;
  public _changed: Set<string>;
  public _isNew: boolean;
  public _originalData: Record<string, unknown>;

  protected static get runtime(): ModelRuntime<JsonObject, JsonObject> {
    return this as unknown as ModelRuntime<JsonObject, JsonObject>;
  }

  protected get runtime(): ModelRuntime<TRecord, TVirtual> {
    return this.constructor as unknown as ModelRuntime<TRecord, TVirtual>;
  }

  protected _setVirtualField(key: string, value: unknown): void {
    (this._virtualFields as Record<string, unknown>)[key] = value;
  }

  constructor(data: Partial<TRecord & TVirtual> = {}, _options: JsonObject = {}) {
    this._data = {};
    this._virtualFields = {};
    this._changed = new Set();
    this._isNew = true;
    this._originalData = {}; // Track original values for detecting in-place JSONB modifications

    // Set up property accessors before applying data so setters map correctly
    this._setupPropertyAccessors();

    const initialData = (data && typeof data === 'object') ? data : {};

    // Apply schema defaults for missing values
    this._applyDefaults(initialData);

    // Apply provided data using setters to respect mappings and change tracking
    for (const [key, value] of Object.entries(initialData)) {
      this.setValue(key, value);
    }

    // Generate virtual field values (may depend on applied data)
    this.generateVirtualValues();
  }

  /**
   * Register a camelCase to snake_case field mapping
   * @param camelCase - camelCase property name
   * @param snakeCase - snake_case database column name
   */
  static _registerFieldMapping(camelCase: string, snakeCase: string): void {
    this.runtime._fieldMappings.set(camelCase, snakeCase);
  }

  /**
   * Register relation metadata for the model
   * @param name - Relation name
   * @param config - Relation configuration
   */
  static defineRelation(name: string, config: JsonObject): void {
    const runtime = this.runtime;
    if (!name || typeof name !== 'string') {
      throw new Error('Relation name must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
      throw new Error(`Relation '${name}' configuration must be an object`);
    }

    if (!runtime._relations || !(runtime._relations instanceof Map)) {
      runtime._relations = new Map();
    }

    const normalizedConfig = this._normalizeRelationConfig(name, config);
    runtime._relations.set(name, normalizedConfig);
  }

  /**
   * Normalize and enrich relation metadata for downstream consumers.
   *
   * @param name - Relation name.
   * @param config - Raw relation configuration.
   * @returns Frozen, normalized relation configuration.
   * @private
   */
  static _normalizeRelationConfig(name: string, config: JsonObject): NormalizedRelationConfig {
    const baseConfig = config && typeof config === 'object' ? { ...config } : {};

    const targetTable = baseConfig.targetTable || baseConfig.table || baseConfig.target;
    if (!targetTable) {
      throw new Error(`Relation '${name}' must define a targetTable or table property.`);
    }

    const targetModelKey = baseConfig.targetModelKey || baseConfig.targetModel || targetTable;

    const rawSource = baseConfig.sourceColumn || baseConfig.sourceKey || baseConfig.sourceField || 'id';
    const sourceColumn = this._getDbFieldName(typeof rawSource === 'string' ? rawSource : String(rawSource));

    const rawTarget = baseConfig.targetColumn || baseConfig.targetKey || baseConfig.targetField || 'id';
    const targetColumn = typeof rawTarget === 'string' ? rawTarget : String(rawTarget);

    const hasRevisions = Boolean(baseConfig.hasRevisions);

    let throughConfig: ThroughRelationConfig | null = null;
    if (baseConfig.through && typeof baseConfig.through === 'object') {
      const rawThrough = baseConfig.through as JsonObject;
      const throughTable = rawThrough.table || rawThrough.name || baseConfig.joinTable;
      if (!throughTable) {
        throw new Error(`Relation '${name}' requires a through.table definition for many-to-many joins.`);
      }

      const throughSourceColumn = rawThrough.sourceColumn || rawThrough.sourceForeignKey || rawThrough.sourceKey;
      const throughTargetColumn = rawThrough.targetColumn || rawThrough.targetForeignKey || rawThrough.targetKey;

      if (!throughSourceColumn || !throughTargetColumn) {
        throw new Error(`Relation '${name}' through definition must include sourceForeignKey and targetForeignKey.`);
      }

      throughConfig = Object.freeze({
        table: String(throughTable),
        sourceColumn: String(throughSourceColumn),
        targetColumn: String(throughTargetColumn),
        sourceCondition: rawThrough.sourceCondition || null,
        targetCondition: rawThrough.targetCondition || null
      });
    }

    const inferredCardinality = baseConfig.cardinality
      || (throughConfig ? 'many' : (sourceColumn === 'id' ? 'many' : 'one'));

    return Object.freeze({
      ...baseConfig,
      targetTable,
      targetModelKey,
      sourceColumn,
      targetColumn,
      hasRevisions,
      cardinality: inferredCardinality,
      isArray: inferredCardinality !== 'one',
      through: throughConfig,
      joinType: throughConfig ? 'through' : 'direct',
      condition: baseConfig.condition || null
    }) as NormalizedRelationConfig;
  }

  /**
   * Retrieve relation metadata by name
   * @param name - Relation name
   * @returns Stored relation configuration
   */
  static getRelation(name: string): NormalizedRelationConfig | null {
    const runtime = this.runtime;
    if (!runtime._relations || !(runtime._relations instanceof Map)) {
      return null;
    }

    return runtime._relations.get(name) || null;
  }

  /**
   * Retrieve all registered relation metadata
   * @returns Array of relation configurations with names
   */
  static getRelations(): Array<{ name: string; config: NormalizedRelationConfig }> {
    const runtime = this.runtime;
    if (!runtime._relations || !(runtime._relations instanceof Map)) {
      return [];
    }

    return Array.from(runtime._relations.entries()).map(([name, config]) => ({
      name,
      config
    }));
  }

  /**
   * Get the database field name for a given property name
   * @param propertyName - Property name (camelCase or snake_case)
   * @returns Database field name (snake_case)
   */
  static _getDbFieldName(propertyName: string): string {
    return this._fieldMappings.get(propertyName) || propertyName;
  }

  /**
   * Get list of database column names filtered by criteria
   * @param filterFn - Filter function for field entries
   * @returns Array of database column names
   * @private
   */
  static _getFilteredColumnNames(filterFn: ([fieldName, fieldDef]: [string, ModelSchemaField]) => boolean): string[] {
    const schema = this.schema;
    if (!schema) return [];

    return Object.entries(schema)
      .filter(filterFn)
      .map(([fieldName]) => this._getDbFieldName(fieldName));
  }

  /**
   * Get list of non-sensitive database column names for safe querying
   * Excludes fields marked as sensitive and virtual fields
   * @returns Array of database column names
   */
  static getSafeColumnNames(): string[] {
    return this._getFilteredColumnNames(
      ([, fieldDef]) => fieldDef && !fieldDef.isVirtual && !fieldDef.isSensitive
    );
  }

  /**
   * Get list of database column names including specified sensitive fields
   * @param includeSensitive - Array of sensitive field names to include
   * @returns Array of database column names
   */
  static getColumnNames(includeSensitive: string[] = []): string[] {
    return this._getFilteredColumnNames(
      ([fieldName, fieldDef]) => {
        if (!fieldDef || fieldDef.isVirtual) return false;
        if (fieldDef.isSensitive && !includeSensitive.includes(fieldName)) return false;
        return true;
      }
    );
  }

  /**
   * Get list of sensitive field names in the schema
   * @returns Array of field names (camelCase)
   */
  static getSensitiveFieldNames(): string[] {
    const schema = this.schema;
    if (!schema) return [];

    return Object.entries(schema)
      .filter(([, fieldDef]) => fieldDef && fieldDef.isSensitive)
      .map(([fieldName]) => fieldName);
  }

  /**
   * Create a new model class
   * @param tableName - Database table name
   * @param schema - Model schema definition
   * @param options - Model options
   * @param dal - DAL instance
   * @returns Model constructor
   */
  static createModel<
    TRecord extends JsonObject,
    TVirtual extends JsonObject = JsonObject,
    TInstance extends Model<TRecord, TVirtual> = Model<TRecord, TVirtual>
  >(
    tableName: string,
    schema: ModelSchema<TRecord, TVirtual>,
    options: JsonObject = {},
    dal: DataAccessLayer
  ): ModelConstructor<TRecord, TVirtual, TInstance> {
    // Create the model constructor
    class DynamicModel extends Model<TRecord, TVirtual> {
      static override _fieldMappings = new Map<string, string>();
      static override _relations = new Map<string, NormalizedRelationConfig>();
      static get tableName() { return tableName; }
      static get schema() { return schema; }
      static get options() { return options; }
      static get dal() { return dal; }
    }

    return DynamicModel as unknown as ModelConstructor<TRecord, TVirtual, TInstance>;
  }

  /**

   * Get a record by ID
   * @param id - Record ID
   * @param options - Query options
   * @param options.includeSensitive - Array of sensitive field names to include
   * @param options (other properties) - Join options for related data (e.g., {teams: true})
   * @returns Model instance
   */
  static async get<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    id: string,
    options: GetOptions = {}
  ): Promise<Model<TRecord, TVirtual>> {
    const query = new QueryBuilder(this, this.dal);

    // Extract includeSensitive option, rest are join options
    const { includeSensitive, ...joinOptions } = options;

    if (includeSensitive && includeSensitive.length > 0) {
      query.includeSensitive(includeSensitive);
    }

    const result = await query
      .filter({ id })
      .getJoin(joinOptions)
      .first();

    if (!result) {
      throw new DocumentNotFound(`${this.tableName} with id ${id} not found`);
    }

    return this._createInstance(result) as Model<TRecord, TVirtual>;
  }

  /**
   * Get multiple records by IDs
   * @param ids - Record IDs
   * @returns Array of model instances
   */
  static async getAll<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    ...ids: string[]
  ): Promise<Array<Model<TRecord, TVirtual>>> {
    if (ids.length === 0) {
      return [];
    }

    const query = new QueryBuilder(this, this.dal);
    const results = await query
      .filter(row => {
        const identifier = (row as { id?: string }).id;
        return Boolean(identifier && ids.includes(identifier));
      })
      .run();

    return results.map(result => this._createInstance(result) as Model<TRecord, TVirtual>);
  }

  /**
   * Filter records by criteria
   * @param criteria - Filter criteria
   * @returns Query builder for chaining
   */
  static filter<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    criteria: unknown
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.filter(criteria as Record<string, unknown>);
  }

  /**
   * Create a new record
   * @param data - Record data
   * @param options - Creation options
   * @returns Created model instance
   */
  static async create<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    data: Partial<TRecord>,
    options: JsonObject = {}
  ): Promise<Model<TRecord, TVirtual>> {
    const instance = new this(data) as Model<TRecord, TVirtual>;
    await instance.save(options);
    return instance;
  }

  /*
*
   * Update a record by ID
   * @param id - Record ID
   * @param data - Update data
   * @returns Updated model instance
   */
  static async update<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    id: string,
    data: Partial<TRecord>
  ): Promise<Model<TRecord, TVirtual>> {
    const instance = await this.get(id);
    for (const [key, value] of Object.entries(data || {})) {
      instance.setValue(key, value);
    }
    await instance.save();
    return instance;
  }

  /**
   * Delete a record by ID
   * @param id - Record ID
   * @returns Success status
   */
  static async delete<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    id: string
  ): Promise<boolean> {
    const query = new QueryBuilder(this, this.dal);
    const result = await query.deleteById(id);
    return result > 0;
  }

  /**
   * Create query builder for ordering
   * @param field - Field to order by
   * @param direction - Sort direction (ASC/DESC)
   * @returns Query builder
   */
  static orderBy<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    field: string,
    direction = 'ASC'
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.orderBy(field, direction);
  }

  /**
   * Create query builder with limit
   * @param count - Limit count
   * @returns Query builder
   */
  static limit<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    count: number
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.limit(count);
  }

  /**
   * Create query builder with joins
   * @param joinSpec - Join specification
   * @returns Query builder
   */
  static getJoin<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    joinSpec: JsonObject
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.getJoin(joinSpec);
  }

  /**
   * Create query builder with date range filter
   * @param startDate - Start date
   * @param endDate - End date
   * @param options - Options for the range
   * @returns Query builder
   */
  static between<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    startDate: Date,
    endDate: Date,
    options: JsonObject = {}
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.between(startDate, endDate, options);
  }

  /**
   * Create query builder with array contains filter
   * @param field - Field name
   * @param value - Value to check for
   * @returns Query builder
   */
  static contains<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    field: string,
    value: unknown
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.contains(field, value);
  }

  /**
   * Filter records to exclude stale and deleted revisions
   * @returns Query builder with revision filters
   */
  static filterNotStaleOrDeleted<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query.filterNotStaleOrDeleted();
  }

  /**
   * Get multiple records by IDs, excluding stale and deleted revisions
   * @param ids - Record IDs
   * @returns Query builder for chaining
   */
  static getMultipleNotStaleOrDeleted<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    ...ids: string[]
  ) {
    const query = new QueryBuilder(this, this.dal);
    return query
      .filter(row => {
        const identifier = (row as { id?: string }).id;
        return Boolean(identifier && ids.includes(identifier));
      })
      .filterNotStaleOrDeleted();
  }

  /**
   * Create a model instance from database result
   * @param data - Database row data
   * @returns Model instance
   * @private
   */
  static _createInstance<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    data: JsonObject | Model<TRecord, TVirtual>
  ): Model<TRecord, TVirtual> {
    // If data is already a Model instance, extract the raw database data
    const rawData = data instanceof this && typeof data._data === 'object' ? data._data : data;

    const instance = new this(rawData) as Model<TRecord, TVirtual>;
    instance._isNew = false;
    instance._changed.clear();
    instance._setupPropertyAccessors();
    instance._trackOriginalValues();

    return instance;
  }

  /**
   * Define an instance method on the model
   * @param name - Method name
   * @param method - Method function
   */
  static define<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    this: ModelRuntime<TRecord, TVirtual>,
    name: string,
    method: (...args: unknown[]) => unknown
  ) {
    this.prototype[name] = method;

    if (name === 'newRevision' || name === 'deleteAllRevisions') {
      if (!this._revisionHandlers) {
        this._revisionHandlers = {};
      }
      this._revisionHandlers[name] = method;
    }
  }

  /**
   * Save the model instance
   * @param options - Save options
   * @returns This instance
   */
  async save(options = {}) {
    try {
      // Detect in-place modifications to JSONB fields before validation
      this._detectInPlaceChanges();

      // Validate data (may also mark fields as changed if validation transforms them)
      this._validate();

      if (this._isNew) {
        await this._insert(options);
      } else {
        await this._update(options);
      }

      this._isNew = false;
      this._changed.clear();

      // Refresh original values after successful save to track future in-place modifications
      this._trackOriginalValues();

      // Regenerate virtual fields after save in case they depend on saved data
      this.generateVirtualValues();

      return this;
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Save with related data
   * @param joinOptions - Options for saving related data
   * @returns This instance
   */
  async saveAll(joinOptions = {}) {
    // First save the main record
    await this.save();

    // Then handle relationships
    const relations = this.runtime.getRelations();

    for (const { name, config } of relations) {
      // Only handle many-to-many relationships with through tables for now
      if (config.cardinality !== 'many' || !config.through) continue;

      // Get the related data from this instance
      const relatedData = this[name];
      if (!relatedData) continue;

      // If joinOptions is explicitly provided, only process requested relationships
      // If joinOptions is empty (default), process all relationships
      const isExplicitOptions = Object.keys(joinOptions).length > 0;
      if (isExplicitOptions && !joinOptions[name]) continue;

      await this._saveManyToManyRelation(name, config, relatedData);
    }

    return this;
  }

  /**
   * Save a many-to-many relationship through a join table
   * @param relationName - Name of the relation
   * @param config - Relation configuration
   * @param relatedData - Array of related model instances or IDs
   * @private
   */
  async _saveManyToManyRelation(relationName, config, relatedData) {
    if (!Array.isArray(relatedData)) {
      return;
    }

    const { through } = config;
    const schemaNamespace = this.runtime.dal.schemaNamespace || '';
    const joinTableName = schemaNamespace ? `${schemaNamespace}${through.table}` : through.table;

    const getBaseName = value => {
      if (!value) return '';
      const segments = String(value).split('.');
      return segments[segments.length - 1];
    };

    const sourceBase = getBaseName(this.runtime.tableName);
    const targetBase = getBaseName(config.targetTable);

    const sourceColumn = through.sourceForeignKey || `${sourceBase.replace(/s$/, '')}_id`;
    const targetColumn = through.targetForeignKey || `${targetBase.replace(/s$/, '')}_id`;

    try {
      // First, remove existing associations for this record
          await this.runtime.dal.query(
        `DELETE FROM ${joinTableName} WHERE ${sourceColumn} = $1`,
        [this.id]
      );

      // Then add new associations
      if (relatedData.length > 0) {
        const values = [];
        const params = [];
        let paramIndex = 1;

        for (const item of relatedData) {
          const itemId = typeof item === 'string' ? item : item.id;
          if (!itemId) continue;

          values.push(`($${paramIndex}, $${paramIndex + 1})`);
          params.push(this.id, itemId);
          paramIndex += 2;
        }

        if (values.length > 0) {
          const insertQuery = `
            INSERT INTO ${joinTableName} (${sourceColumn}, ${targetColumn})
            VALUES ${values.join(', ')}
            ON CONFLICT (${sourceColumn}, ${targetColumn}) DO NOTHING
          `;

          await this.runtime.dal.query(insertQuery, params);
        }
      }
    } catch (error) {
      throw new Error(`Failed to save ${relationName} relation: ${error.message}`);
    }
  }  /*
*
   * Delete this model instance
   * @returns Success status
   */
  async delete() {
    if (this._isNew) {
      throw new Error('Cannot delete unsaved record');
    }

    const runtime = this.runtime;
    const query = new QueryBuilder(runtime, runtime.dal);
    const result = await query.deleteById(String(this.id));
    return result > 0;
  }

  /**
   * Ensure a revision handler is available for this model runtime
   * @param handlerName - Revision handler to initialize
   * @returns Revision handler function
   */
  static _ensureRevisionHandler(
    this: RuntimeModel<JsonObject, JsonObject, Model<JsonObject, JsonObject>>,
    handlerName: RevisionHandlerName
  ) {
    if (!this._revisionHandlers) {
      this._revisionHandlers = {};
    }

    if (this._revisionHandlers[handlerName]) {
      return this._revisionHandlers[handlerName];
    }

    const hasRevisionFields = this.schema && Object.prototype.hasOwnProperty.call(this.schema, '_revID');
    if (!hasRevisionFields) {
      const modelName = this.tableName || this.name || 'Model';
      throw new Error(`Revision support is not enabled for ${modelName}`);
    }

    switch (handlerName) {
      case 'newRevision':
        this._revisionHandlers.newRevision = revision.getNewRevisionHandler(
          this as unknown as ModelConstructorLike
        );
        break;
      case 'deleteAllRevisions':
        this._revisionHandlers.deleteAllRevisions = revision.getDeleteAllRevisionsHandler(
          this as unknown as ModelConstructorLike
        );
        break;
      default:
        throw new Error(`Unknown revision handler requested: ${handlerName}`);
    }

    return this._revisionHandlers[handlerName];
  }

  async newRevision(user, options = {}) {
    const handler = this.runtime._ensureRevisionHandler('newRevision');
    return handler.call(this, user, options);
  }

  /**
   * Delete all revisions of this model instance
   * This method will be dynamically assigned by revision handlers
   * @param user - User performing the deletion
   * @param options - Deletion options
   * @returns Deletion revision
   */
  async deleteAllRevisions(user, options = {}) {
    const handler = this.runtime._ensureRevisionHandler('deleteAllRevisions');
    return handler.call(this, user, options);
  }

  /**
   * Generate virtual field values
   */
  generateVirtualValues() {
    const schema = this.runtime.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && fieldDef.isVirtual) {
        // For virtual fields, we need to access the raw defaultValue function
        if (fieldDef.hasDefault) {
          const defaultValue = this._resolveDefault(fieldDef);
          if (defaultValue !== undefined) {
            this._setVirtualField(fieldName, defaultValue);
          }
        }
      }
    }
  }

  /**
   * Set up dynamic property accessors for schema fields
   * @private
   */
  _setupPropertyAccessors() {
    const schema = this.runtime.schema;

    for (const fieldName of Object.keys(schema)) {
      // Skip if property already exists
      if (this.hasOwnProperty(fieldName)) {
        continue;
      }

      // Create getter/setter for each schema field
      Object.defineProperty(this, fieldName, {
        get() {
          return this.getValue(fieldName);
        },
        set(value) {
          this.setValue(fieldName, value);
        },
        enumerable: true,
        configurable: true
      });
    }
  }

  /**
   * Store deep copies of JSONB fields to detect in-place modifications
   * This allows detection of changes to nested properties without calling setters
   * @private
   */
  _trackOriginalValues() {
    const schema = this.runtime.schema || {};
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual) {
        const dbFieldName = this.runtime._getDbFieldName(fieldName);
        const value = this._data[dbFieldName];

        // Deep clone objects and arrays to track original state
        if (value !== null && value !== undefined && typeof value === 'object') {
          this._originalData[dbFieldName] = deepClone(value);
        } else {
          // Clear tracking for non-object values (primitives don't need tracking)
          delete this._originalData[dbFieldName];
        }
      }
    }
  }

  /**
   * Detect in-place modifications to JSONB fields
   * For objects/arrays loaded from database, detect if they were mutated without calling setters
   * @private
   */
  _detectInPlaceChanges() {
    // Only check persisted records (new records have no "original" state to compare)
    if (this._isNew) return;

    const schema = this.runtime.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual && !fieldName.startsWith('_')) {
        const dbFieldName = this.runtime._getDbFieldName(fieldName);
        const originalValue = this._originalData[dbFieldName];

        // Only check fields we're tracking (objects/arrays from DB load)
        if (originalValue !== undefined) {
          const currentValue = this.getValue(fieldName);

          // Compare current state to original snapshot
          if (!deepEqual(currentValue, originalValue)) {
            // Mark as changed by calling setValue with current value
            this.setValue(fieldName, currentValue);
          }
        }
      }
    }
  }

  /**
   * Validate model data against schema
   * Validates types, runs custom validators, and may transform values
   * @private
   */
  _validate() {
    const schema = this.runtime.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual) {
        // Use getValue/setValue for all fields to respect field mappings
        const value = this.getValue(fieldName);
        const validatedValue = fieldDef.validate(value, fieldName);

        // If validation transformed the value, update it and mark as changed
        if (!deepEqual(validatedValue, value)) {
          this.setValue(fieldName, validatedValue);
        }
      }
    }
  }

  /**
   * Insert new record
   * @param options - Insert options
   * @private
   */
  async _insert(options) {
    const tableName = this.runtime.tableName;
    const fields = Object.keys(this._data).filter(key => this._data[key] !== undefined);
    const values = fields.map(key => this._data[key]);
    const placeholders = fields.map((_, index) => `$${index + 1}`);

    const query = `
      INSERT INTO ${tableName} (${fields.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result = await this.runtime.dal.query(query, values);
    Object.assign(this._data, result.rows[0]);
  }

  /**
   * Update existing record
   * @param options - Update options
   * @param options.updateSensitive - Array of sensitive field names to include in update
   * @private
   */
  async _update(options) {
    if (this._changed.size === 0) {
      return; // No changes to save
    }

    const tableName = this.runtime.tableName;
    const allowedSensitive = new Set(options.updateSensitive || []);
    const sensitiveFields = new Set(this.runtime.getSensitiveFieldNames());

    // Build reverse map: db field name -> schema field name
    const dbToSchemaMap = new Map();
    for (const [schemaName, dbName] of this.runtime._fieldMappings) {
      dbToSchemaMap.set(dbName, schemaName);
    }

    const changedFields = Array.from(this._changed).filter(dbFieldName => {
      const schemaFieldName = dbToSchemaMap.get(dbFieldName) || dbFieldName;
      if (sensitiveFields.has(schemaFieldName)) {
        return allowedSensitive.has(schemaFieldName);
      }

      return true;
    });

    if (changedFields.length === 0) {
      return; // No non-sensitive changes to save
    }

    const values = changedFields.map(key => this._data[key]);
    const setClause = changedFields.map((key, index) => `${key} = $${index + 1}`);

    const query = `
      UPDATE ${tableName}
      SET ${setClause.join(', ')}
      WHERE id = $${values.length + 1}
      RETURNING *
    `;

    const result = await this.runtime.dal.query(query, [...values, this.id]);
    if (result.rows.length === 0) {
      throw new DocumentNotFound(`${tableName} with id ${this.id} not found`);
    }

    Object.assign(this._data, result.rows[0]);
  }

  // Property getters and setters
  get id(): string | undefined {
    const value = this._data.id;
    return typeof value === 'string' ? value : undefined;
  }

  set id(value: string | undefined) {
    this._data.id = value;
    this._changed.add('id');
  }

  /**
   * Get property value (data or virtual)
   * @param key - Property name (camelCase or snake_case)
   * @returns Property value
   */
  getValue(key) {
    const schema = this.runtime.schema;

    if (this._virtualFields.hasOwnProperty(key)) {
      return this._virtualFields[key];
    }

    // Get the actual database field name
    const dbFieldName = this.runtime._getDbFieldName(key);
    return this._data[dbFieldName];
  }

  /**
   * Set property value
   * @param key - Property name (camelCase or snake_case)
   * @param value - Property value
   */
  setValue(key, value) {
    const schema = this.runtime.schema;

    if (schema[key] && schema[key].isVirtual) {
      this._setVirtualField(key, value);
    } else {
      // Get the actual database field name
      const dbFieldName = this.runtime._getDbFieldName(key);
      this._data[dbFieldName] = value;
      this._changed.add(dbFieldName);
    }
  }

  /**
   * Apply default values defined in the schema for missing fields
   * @param initialData - The initial payload passed to the constructor
   * @private
   */
  _applyDefaults(initialData = {}) {
    const schema = this.runtime.schema || {};

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (!fieldDef || fieldDef.isVirtual || !fieldDef.hasDefault) {
        continue;
      }

      const dbFieldName = this.runtime._getDbFieldName(fieldName);
      const hasInitialValue = Object.prototype.hasOwnProperty.call(initialData, fieldName) ||
        (dbFieldName !== fieldName && Object.prototype.hasOwnProperty.call(initialData, dbFieldName));

      if (hasInitialValue) {
        continue;
      }

      const defaultValue = this._resolveDefault(fieldDef);
      if (defaultValue !== undefined) {
        this.setValue(fieldName, defaultValue);
      }
    }
  }

  /**
   * Resolve a type default value, honoring functions that rely on instance context
   * @param fieldDef - Schema field definition
   * @returns Default value or undefined if none
   * @private
   */
  _resolveDefault(fieldDef) {
    if (!fieldDef || !fieldDef.hasDefault) {
      return undefined;
    }

    if (typeof fieldDef.getDefault === 'function') {
      try {
        const value = fieldDef.getDefault();
        if (value !== undefined) {
          return value;
        }
      } catch (error) {
        if (typeof fieldDef.defaultValue !== 'function') {
          throw error;
        }
        return fieldDef.defaultValue.call(this);
      }
    }

    if (typeof fieldDef.defaultValue === 'function') {
      return fieldDef.defaultValue.call(this);
    }

    return fieldDef.defaultValue;
  }
}

type RuntimeModel<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends Model<TRecord, TVirtual>
> = ModelConstructor<TRecord, TVirtual, TInstance> & typeof Model & {
  schema: ModelSchema<TRecord, TVirtual>;
  tableName: string;
  options?: JsonObject;
  dal: DataAccessLayer;
  _fieldMappings: Map<string, string>;
  _relations: Map<string, NormalizedRelationConfig>;
  _revisionHandlers?: RevisionHandlerMap<TInstance>;
};

type ModelRuntime<
  TRecord extends JsonObject,
  TVirtual extends JsonObject
> = RuntimeModel<TRecord, TVirtual, Model<TRecord, TVirtual>>;

export type { ModelRuntime };
export { Model };
export default Model;

