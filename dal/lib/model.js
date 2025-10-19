'use strict';

/**
 * Base Model class for PostgreSQL DAL
 * 
 * Provides CRUD operations, virtual fields, and query building functionality
 * that maintains compatibility with the existing Thinky model interface.
 */

const QueryBuilder = require('./query-builder');
const { DocumentNotFound, ValidationError, convertPostgreSQLError } = require('./errors');
const debug = require('../../util/debug');

/**
 * Base Model class
 */
class Model {
  constructor(data = {}, options = {}) {
    this._data = {};
    this._virtualFields = {};
    this._changed = new Set();
    this._isNew = true;
    
    // Set initial data
    Object.assign(this._data, data);
    
    // Generate virtual field values
    this.generateVirtualValues();
    
    // Set up property accessors
    this._setupPropertyAccessors();
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
      static get tableName() { return tableName; }
      static get schema() { return schema; }
      static get options() { return options; }
      static get dal() { return dal; }
    }
    
    return DynamicModel;
  }  /**

   * Get a record by ID
   * @param {string} id - Record ID
   * @param {Object} joinOptions - Join options for related data
   * @returns {Promise<Model>} Model instance
   */
  static async get(id, joinOptions = {}) {
    const query = new QueryBuilder(this, this.dal);
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
    Object.assign(instance._data, data);
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
    const instance = new this(data);
    instance._isNew = false;
    instance._changed.clear();
    instance._setupPropertyAccessors();
    return instance;
  }

  /**
   * Define an instance method on the model
   * @param {string} name - Method name
   * @param {Function} method - Method function
   */
  static define(name, method) {
    this.prototype[name] = method;
  }

  /**
   * Save the model instance
   * @param {Object} options - Save options
   * @returns {Promise<Model>} This instance
   */
  async save(options = {}) {
    try {
      // Validate data
      this._validate();
      
      if (this._isNew) {
        await this._insert(options);
      } else {
        await this._update(options);
      }
      
      this._isNew = false;
      this._changed.clear();
      
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
    // For now, just save the main record
    // Full join saving would be implemented in a future iteration
    return await this.save();
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
  async newRevision(user, options = {}) {
    throw new Error('newRevision method not implemented. Use revision.getNewRevisionHandler() to add this method.');
  }

  /**
   * Delete all revisions of this model instance
   * This method will be dynamically assigned by revision handlers
   * @param {Object} user - User performing the deletion
   * @param {Object} options - Deletion options
   * @returns {Promise<Model>} Deletion revision
   */
  async deleteAllRevisions(user, options = {}) {
    throw new Error('deleteAllRevisions method not implemented. Use revision.getDeleteAllRevisionsHandler() to add this method.');
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
          const defaultValue = fieldDef.defaultValue;
          const computedValue = typeof defaultValue === 'function' 
            ? defaultValue.call(this) 
            : defaultValue;
          this._virtualFields[fieldName] = computedValue;
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
   * Validate model data against schema
   * @private
   */
  _validate() {
    const schema = this.constructor.schema;
    
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef && !fieldDef.isVirtual) {
        const value = this._data[fieldName];
        this._data[fieldName] = fieldDef.validate(value, fieldName);
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
  }  /*
*
   * Update existing record
   * @param {Object} options - Update options
   * @private
   */
  async _update(options) {
    if (this._changed.size === 0) {
      return; // No changes to save
    }
    
    const tableName = this.constructor.tableName;
    const changedFields = Array.from(this._changed);
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
   * @param {string} key - Property name
   * @returns {*} Property value
   */
  getValue(key) {
    if (this._virtualFields.hasOwnProperty(key)) {
      return this._virtualFields[key];
    }
    return this._data[key];
  }

  /**
   * Set property value
   * @param {string} key - Property name
   * @param {*} value - Property value
   */
  setValue(key, value) {
    const schema = this.constructor.schema;
    
    if (schema[key] && schema[key].isVirtual) {
      this._virtualFields[key] = value;
    } else {
      this._data[key] = value;
      this._changed.add(key);
    }
  }
}

module.exports = Model;