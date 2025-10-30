'use strict';

/**
 * Base Model class for PostgreSQL DAL
 * 
 * Provides CRUD operations, virtual fields, and query building functionality
 * that maintains compatibility with the existing Thinky model interface.
 */

const QueryBuilder = require('./query-builder');
const { DocumentNotFound, ValidationError, convertPostgreSQLError } = require('./errors');
const revision = require('./revision');
const debug = require('../../util/debug');

/**
 * Deep equality comparison for detecting actual changes in validated values
 * @param {*} a - First value
 * @param {*} b - Second value
 * @returns {boolean} True if values are deeply equal
 * @private
 */
function deepEqual(a, b) {
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
 * @param {*} value - Value to clone
 * @returns {*} Cloned value
 * @private
 */
function deepClone(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(item => deepClone(item));
  if (typeof value === 'object') {
    const cloned = {};
    for (const key in value) {
      if (value.hasOwnProperty(key)) {
        cloned[key] = deepClone(value[key]);
      }
    }
    return cloned;
  }
  return value;
}

/**
 * Base Model class
 */
class Model {
  constructor(data = {}, options = {}) {
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
   * Field mappings registry for camelCase to snake_case conversion
   * @type {Map<string, string>}
   * @static
   */
  static _fieldMappings = new Map();

  /**
   * Relation metadata registry keyed by relation name
   * @type {Map<string, Object>}
   * @static
   */
  static _relations = new Map();

  /**
   * Register a camelCase to snake_case field mapping
   * @param {string} camelCase - camelCase property name
   * @param {string} snakeCase - snake_case database column name
   * @static
   */
  static _registerFieldMapping(camelCase, snakeCase) {
    this._fieldMappings.set(camelCase, snakeCase);
  }

  /**
   * Register relation metadata for the model
   * @param {string} name - Relation name
   * @param {Object} config - Relation configuration
   * @static
   */
  static defineRelation(name, config) {
    if (!name || typeof name !== 'string') {
      throw new Error('Relation name must be a non-empty string');
    }

    if (!config || typeof config !== 'object') {
      throw new Error(`Relation '${name}' configuration must be an object`);
    }

    if (!this._relations || !(this._relations instanceof Map)) {
      this._relations = new Map();
    }

    const normalizedConfig = this._normalizeRelationConfig(name, config);
    this._relations.set(name, normalizedConfig);
  }

  /**
   * Normalize and enrich relation metadata for downstream consumers.
   *
   * @param {string} name - Relation name.
   * @param {Object} config - Raw relation configuration.
   * @returns {Object} Frozen, normalized relation configuration.
   * @private
   */
  static _normalizeRelationConfig(name, config) {
    const baseConfig = config && typeof config === 'object' ? { ...config } : {};

    const targetTable = baseConfig.targetTable || baseConfig.table || baseConfig.target;
    if (!targetTable) {
      throw new Error(`Relation '${name}' must define a targetTable or table property.`);
    }

    const targetModelKey = baseConfig.targetModelKey || baseConfig.targetModel || targetTable;

    const rawSource = baseConfig.sourceColumn || baseConfig.sourceKey || baseConfig.sourceField || 'id';
    const sourceColumn = this._getDbFieldName ? this._getDbFieldName(rawSource) : rawSource;

    const rawTarget = baseConfig.targetColumn || baseConfig.targetKey || baseConfig.targetField || 'id';
    const targetColumn = rawTarget;

    const hasRevisions = Boolean(baseConfig.hasRevisions);

    let throughConfig = null;
    if (baseConfig.through && typeof baseConfig.through === 'object') {
      const rawThrough = baseConfig.through;
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
        table: throughTable,
        sourceColumn: throughSourceColumn,
        targetColumn: throughTargetColumn,
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
    });
  }

  /**
   * Retrieve relation metadata by name
   * @param {string} name - Relation name
   * @returns {Object|null} Stored relation configuration
   * @static
   */
  static getRelation(name) {
    if (!this._relations || !(this._relations instanceof Map)) {
      return null;
    }

    return this._relations.get(name) || null;
  }

  /**
   * Retrieve all registered relation metadata
   * @returns {Object[]} Array of relation configurations with names
   * @static
   */
  static getRelations() {
    if (!this._relations || !(this._relations instanceof Map)) {
      return [];
    }

    return Array.from(this._relations.entries()).map(([name, config]) => ({
      name,
      config
    }));
  }

  /**
   * Get the database field name for a given property name
   * @param {string} propertyName - Property name (camelCase or snake_case)
   * @returns {string} Database field name (snake_case)
   * @static
   */
  static _getDbFieldName(propertyName) {
    return this._fieldMappings.get(propertyName) || propertyName;
  }

  /**
   * Get list of database column names filtered by criteria
   * @param {Function} filterFn - Filter function for field entries
   * @returns {string[]} Array of database column names
   * @private
   * @static
   */
  static _getFilteredColumnNames(filterFn) {
    const schema = this.schema;
    if (!schema) return [];

    return Object.entries(schema)
      .filter(filterFn)
      .map(([fieldName]) => this._getDbFieldName(fieldName));
  }

  /**
   * Get list of non-sensitive database column names for safe querying
   * Excludes fields marked as sensitive and virtual fields
   * @returns {string[]} Array of database column names
   * @static
   */
  static getSafeColumnNames() {
    return this._getFilteredColumnNames(
      ([, fieldDef]) => fieldDef && !fieldDef.isVirtual && !fieldDef.isSensitive
    );
  }

  /**
   * Get list of database column names including specified sensitive fields
   * @param {string[]} includeSensitive - Array of sensitive field names to include
   * @returns {string[]} Array of database column names
   * @static
   */
  static getColumnNames(includeSensitive = []) {
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
   * @returns {string[]} Array of field names (camelCase)
   * @static
   */
  static getSensitiveFieldNames() {
    const schema = this.schema;
    if (!schema) return [];

    return Object.entries(schema)
      .filter(([, fieldDef]) => fieldDef && fieldDef.isSensitive)
      .map(([fieldName]) => fieldName);
  }

  /**
   * Create a new model class
   * @param {string} tableName - Database table name
   * @param {Object} schema - Model schema definition
   * @param {Object} options - Model options
   * @param {DataAccessLayer} dal - DAL instance
   * @returns {Function} Model constructor
   */
  static createModel(tableName, schema, options = {}, dal) {
    // Create the model constructor
    class DynamicModel extends Model {
      static _fieldMappings = new Map();
      static _relations = new Map();
      static get tableName() { return tableName; }
      static get schema() { return schema; }
      static get options() { return options; }
      static get dal() { return dal; }
    }
    
    return DynamicModel;
  }  /**

   * Get a record by ID
   * @param {string} id - Record ID
   * @param {Object} options - Query options
   * @param {string[]} options.includeSensitive - Array of sensitive field names to include
   * @param {Object} options (other properties) - Join options for related data (e.g., {teams: true})
   * @returns {Promise<Model>} Model instance
   */
  static async get(id, options = {}) {
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

    return this._createInstance(result);
  }

  /**
   * Get multiple records by IDs
   * @param {...string} ids - Record IDs
   * @returns {Promise<Model[]>} Array of model instances
   */
  static async getAll(...ids) {
    if (ids.length === 0) {
      return [];
    }
    
    const query = new QueryBuilder(this, this.dal);
    const results = await query
      .filter(row => ids.includes(row.id))
      .run();
    
    return results.map(result => this._createInstance(result));
  }

  /**
   * Filter records by criteria
   * @param {Object|Function} criteria - Filter criteria
   * @returns {QueryBuilder} Query builder for chaining
   */
  static filter(criteria) {
    const query = new QueryBuilder(this, this.dal);
    return query.filter(criteria);
  }

  /**
   * Create a new record
   * @param {Object} data - Record data
   * @param {Object} options - Creation options
   * @returns {Promise<Model>} Created model instance
   */
  static async create(data, options = {}) {
    const instance = new this(data);
    await instance.save(options);
    return instance;
  }  /*
*
   * Update a record by ID
   * @param {string} id - Record ID
   * @param {Object} data - Update data
   * @returns {Promise<Model>} Updated model instance
   */
  static async update(id, data) {
    const instance = await this.get(id);
    for (const [key, value] of Object.entries(data || {})) {
      instance.setValue(key, value);
    }
    await instance.save();
    return instance;
  }

  /**
   * Delete a record by ID
   * @param {string} id - Record ID
   * @returns {Promise<boolean>} Success status
   */
  static async delete(id) {
    const query = new QueryBuilder(this, this.dal);
    const result = await query.deleteById(id);
    return result.rowCount > 0;
  }

  /**
   * Create query builder for ordering
   * @param {string} field - Field to order by
   * @param {string} direction - Sort direction (ASC/DESC)
   * @returns {QueryBuilder} Query builder
   */
  static orderBy(field, direction = 'ASC') {
    const query = new QueryBuilder(this, this.dal);
    return query.orderBy(field, direction);
  }

  /**
   * Create query builder with limit
   * @param {number} count - Limit count
   * @returns {QueryBuilder} Query builder
   */
  static limit(count) {
    const query = new QueryBuilder(this, this.dal);
    return query.limit(count);
  }

  /**
   * Create query builder with joins
   * @param {Object} joinSpec - Join specification
   * @returns {QueryBuilder} Query builder
   */
  static getJoin(joinSpec) {
    const query = new QueryBuilder(this, this.dal);
    return query.getJoin(joinSpec);
  }

  /**
   * Create query builder with date range filter
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {Object} options - Options for the range
   * @returns {QueryBuilder} Query builder
   */
  static between(startDate, endDate, options = {}) {
    const query = new QueryBuilder(this, this.dal);
    return query.between(startDate, endDate, options);
  }

  /**
   * Create query builder with array contains filter
   * @param {string} field - Field name
   * @param {*} value - Value to check for
   * @returns {QueryBuilder} Query builder
   */
  static contains(field, value) {
    const query = new QueryBuilder(this, this.dal);
    return query.contains(field, value);
  }

  /**
   * Filter records to exclude stale and deleted revisions
   * @returns {QueryBuilder} Query builder with revision filters
   */
  static filterNotStaleOrDeleted() {
    const query = new QueryBuilder(this, this.dal);
    return query.filterNotStaleOrDeleted();
  }

  /**
   * Get multiple records by IDs, excluding stale and deleted revisions
   * @param {...string} ids - Record IDs
   * @returns {QueryBuilder} Query builder for chaining
   */
  static getMultipleNotStaleOrDeleted(...ids) {
    const query = new QueryBuilder(this, this.dal);
    return query
      .filter(row => ids.includes(row.id))
      .filterNotStaleOrDeleted();
  }

  /**
   * Create a model instance from database result
   * @param {Object} data - Database row data
   * @returns {Model} Model instance
   * @private
   */
  static _createInstance(data) {
    // If data is already a Model instance, extract the raw database data
    const rawData = data && data._data && typeof data._data === 'object' ? data._data : data;

    const instance = new this(rawData);
    instance._isNew = false;
    instance._changed.clear();
    instance._setupPropertyAccessors();
    instance._trackOriginalValues();

    return instance;
  }

  /**
   * Define an instance method on the model
   * @param {string} name - Method name
   * @param {Function} method - Method function
   */
  static define(name, method) {
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
   * @param {Object} options - Save options
   * @returns {Promise<Model>} This instance
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
   * @param {Object} joinOptions - Options for saving related data
   * @returns {Promise<Model>} This instance
   */
  async saveAll(joinOptions = {}) {
    // First save the main record
    await this.save();
    
    // Then handle relationships
    const relations = this.constructor.getRelations();
    
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
   * @param {string} relationName - Name of the relation
   * @param {Object} config - Relation configuration
   * @param {Array} relatedData - Array of related model instances or IDs
   * @private
   */
  async _saveManyToManyRelation(relationName, config, relatedData) {
    if (!Array.isArray(relatedData)) {
      return;
    }

    const { through } = config;
    const schemaNamespace = this.constructor.dal.schemaNamespace || '';
    const joinTableName = schemaNamespace ? `${schemaNamespace}${through.table}` : through.table;

    const getBaseName = value => {
      if (!value) return '';
      const segments = String(value).split('.');
      return segments[segments.length - 1];
    };

    const sourceBase = getBaseName(this.constructor.tableName);
    const targetBase = getBaseName(config.targetTable);

    const sourceColumn = through.sourceForeignKey || `${sourceBase.replace(/s$/, '')}_id`;
    const targetColumn = through.targetForeignKey || `${targetBase.replace(/s$/, '')}_id`;
    
    try {
      // First, remove existing associations for this record
      await this.constructor.dal.query(
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

          await this.constructor.dal.query(insertQuery, params);
        }
      }
    } catch (error) {
      throw new Error(`Failed to save ${relationName} relation: ${error.message}`);
    }
  }  /*
*
   * Delete this model instance
   * @returns {Promise<boolean>} Success status
   */
  async delete() {
    if (this._isNew) {
      throw new Error('Cannot delete unsaved record');
    }
    
    const query = new QueryBuilder(this.constructor, this.constructor.dal);
    const result = await query.deleteById(this.id);
    return result.rowCount > 0;
  }

  /**
   * Create a new revision of this model instance
   * This method will be dynamically assigned by revision handlers
   * @param {Object} user - User creating the revision
   * @param {Object} options - Revision options
   * @returns {Promise<Model>} New revision instance
   */
  static _ensureRevisionHandler(handlerName) {
    if (!this._revisionHandlers) {
      this._revisionHandlers = {};
    }

    if (this._revisionHandlers[handlerName]) {
      return this._revisionHandlers[handlerName];
    }

    const hasRevisionFields = this.schema && Object.prototype.hasOwnProperty.call(this.schema, '_rev_id');
    if (!hasRevisionFields) {
      const modelName = this.tableName || this.name || 'Model';
      throw new Error(`Revision support is not enabled for ${modelName}`);
    }

    switch (handlerName) {
      case 'newRevision':
        this._revisionHandlers.newRevision = revision.getNewRevisionHandler(this);
        break;
      case 'deleteAllRevisions':
        this._revisionHandlers.deleteAllRevisions = revision.getDeleteAllRevisionsHandler(this);
        break;
      default:
        throw new Error(`Unknown revision handler requested: ${handlerName}`);
    }

    return this._revisionHandlers[handlerName];
  }

  async newRevision(user, options = {}) {
    const handler = this.constructor._ensureRevisionHandler('newRevision');
    return handler.call(this, user, options);
  }

  /**
   * Delete all revisions of this model instance
   * This method will be dynamically assigned by revision handlers
   * @param {Object} user - User performing the deletion
   * @param {Object} options - Deletion options
   * @returns {Promise<Model>} Deletion revision
   */
  async deleteAllRevisions(user, options = {}) {
    const handler = this.constructor._ensureRevisionHandler('deleteAllRevisions');
    return handler.call(this, user, options);
  }

  /**
   * Generate virtual field values
   */
  generateVirtualValues() {
    const schema = this.constructor.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && fieldDef.isVirtual) {
        // For virtual fields, we need to access the raw defaultValue function
        if (fieldDef.hasDefault) {
          const defaultValue = this._resolveDefault(fieldDef);
          if (defaultValue !== undefined) {
            this._virtualFields[fieldName] = defaultValue;
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
    const schema = this.constructor.schema;

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
    const schema = this.constructor.schema || {};
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual) {
        const dbFieldName = this.constructor._getDbFieldName(fieldName);
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

    const schema = this.constructor.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual && !fieldName.startsWith('_')) {
        const dbFieldName = this.constructor._getDbFieldName(fieldName);
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
    const schema = this.constructor.schema;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual) {
        // Revision fields (starting with _) are internal database fields
        // that don't use the camelCase accessor system
        if (fieldName.startsWith('_')) {
          const value = this._data[fieldName];
          this._data[fieldName] = fieldDef.validate(value, fieldName);
        } else {
          // Regular fields use the camelCase property accessor
          const value = this.getValue(fieldName);
          const validatedValue = fieldDef.validate(value, fieldName);

          // If validation transformed the value, update it and mark as changed
          if (!deepEqual(validatedValue, value)) {
            this.setValue(fieldName, validatedValue);
          }
        }
      }
    }
  }

  /**
   * Insert new record
   * @param {Object} options - Insert options
   * @private
   */
  async _insert(options) {
    const tableName = this.constructor.tableName;
    const fields = Object.keys(this._data).filter(key => this._data[key] !== undefined);
    const values = fields.map(key => this._data[key]);
    const placeholders = fields.map((_, index) => `$${index + 1}`);

    const query = `
      INSERT INTO ${tableName} (${fields.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result = await this.constructor.dal.query(query, values);
    Object.assign(this._data, result.rows[0]);
  }  /**
   * Update existing record
   * @param {Object} options - Update options
   * @param {string[]} options.updateSensitive - Array of sensitive field names to include in update
   * @private
   */
  async _update(options) {
    if (this._changed.size === 0) {
      return; // No changes to save
    }

    const tableName = this.constructor.tableName;
    const allowedSensitive = new Set(options.updateSensitive || []);
    const sensitiveFields = new Set(this.constructor.getSensitiveFieldNames());

    // Build reverse map: db field name -> schema field name
    const dbToSchemaMap = new Map();
    for (const [schemaName, dbName] of this.constructor._fieldMappings) {
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

    const result = await this.constructor.dal.query(query, [...values, this.id]);
    if (result.rows.length === 0) {
      throw new DocumentNotFound(`${tableName} with id ${this.id} not found`);
    }

    Object.assign(this._data, result.rows[0]);
  }

  // Property getters and setters
  get id() {
    return this._data.id;
  }

  set id(value) {
    this._data.id = value;
    this._changed.add('id');
  }

  /**
   * Get property value (data or virtual)
   * @param {string} key - Property name (camelCase or snake_case)
   * @returns {*} Property value
   */
  getValue(key) {
    const schema = this.constructor.schema;
    
    if (this._virtualFields.hasOwnProperty(key)) {
      return this._virtualFields[key];
    }
    
    // Get the actual database field name
    const dbFieldName = this.constructor._getDbFieldName(key);
    return this._data[dbFieldName];
  }

  /**
   * Set property value
   * @param {string} key - Property name (camelCase or snake_case)
   * @param {*} value - Property value
   */
  setValue(key, value) {
    const schema = this.constructor.schema;

    if (schema[key] && schema[key].isVirtual) {
      this._virtualFields[key] = value;
    } else {
      // Get the actual database field name
      const dbFieldName = this.constructor._getDbFieldName(key);
      this._data[dbFieldName] = value;
      this._changed.add(dbFieldName);
    }
  }

  /**
   * Apply default values defined in the schema for missing fields
   * @param {Object} initialData - The initial payload passed to the constructor
   * @private
   */
  _applyDefaults(initialData = {}) {
    const schema = this.constructor.schema || {};

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (!fieldDef || fieldDef.isVirtual || !fieldDef.hasDefault) {
        continue;
      }

      const dbFieldName = this.constructor._getDbFieldName(fieldName);
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
   * @param {Object} fieldDef - Schema field definition
   * @returns {*} Default value or undefined if none
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

module.exports = Model;
