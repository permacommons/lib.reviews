'use strict';

/**
 * Query Builder for PostgreSQL DAL
 * 
 * Provides a fluent interface for building and executing database queries
 * that maintains compatibility with the existing RethinkDB/Thinky query patterns.
 */

const { DocumentNotFound, convertPostgreSQLError } = require('./errors');
const debug = require('../../util/debug');

class QueryBuilder {
  constructor(modelClass, dal) {
    this.modelClass = modelClass;
    this.dal = dal;
    this.tableName = modelClass.tableName;
    
    // Query components
    this._select = ['*'];
    this._where = [];
    this._joins = [];
    this._orderBy = [];
    this._limit = null;
    this._offset = null;
    this._params = [];
    this._paramIndex = 1;
  }

  /**
   * Add WHERE conditions
   * @param {Object|Function} criteria - Filter criteria
   * @returns {QueryBuilder} This instance for chaining
   */
  filter(criteria) {
    if (typeof criteria === 'function') {
      // For now, function-based filters are not fully implemented
      // This would require a more sophisticated query parser
      throw new Error('Function-based filters not yet implemented');
    }
    
    if (typeof criteria === 'object' && criteria !== null) {
      for (const [key, value] of Object.entries(criteria)) {
        // Convert camelCase property names to snake_case database field names
        // Fallback to original key if _getDbFieldName is not available (for tests)
        const dbFieldName = this.modelClass._getDbFieldName ? 
          this.modelClass._getDbFieldName(key) : key;
        this._addWhereCondition(dbFieldName, '=', value);
      }
    }
    
    return this;
  }

  /**
   * Filter out stale (old) and deleted revisions
   * Uses PostgreSQL partial indexes for optimal performance
   * @returns {QueryBuilder} This instance for chaining
   */
  filterNotStaleOrDeleted() {
    // Add conditions to filter current, non-deleted revisions
    // This leverages the partial indexes created in the schema
    this._addWhereCondition('_old_rev_of', 'IS', null);
    this._addWhereCondition('_rev_deleted', '=', false);
    return this;
  }

  /**
   * Filter by revision user
   * @param {string} userId - User ID who created the revision
   * @returns {QueryBuilder} This instance for chaining
   */
  filterByRevisionUser(userId) {
    this._addWhereCondition('_rev_user', '=', userId);
    return this;
  }

  /**
   * Filter by revision tags
   * @param {string|string[]} tags - Tag or array of tags to filter by
   * @returns {QueryBuilder} This instance for chaining
   */
  filterByRevisionTags(tags) {
    const tagArray = Array.isArray(tags) ? tags : [tags];
    
    // Use PostgreSQL array overlap operator
    const placeholder = `$${this._paramIndex++}`;
    this._where.push(`_rev_tags && ${placeholder}`);
    this._params.push(tagArray);
    
    return this;
  }

  /**
   * Filter by revision date range
   * @param {Date} startDate - Start date (inclusive)
   * @param {Date} endDate - End date (inclusive)
   * @returns {QueryBuilder} This instance for chaining
   */
  filterByRevisionDateRange(startDate, endDate) {
    if (startDate) {
      this._addWhereCondition('_rev_date', '>=', startDate);
    }
    if (endDate) {
      this._addWhereCondition('_rev_date', '<=', endDate);
    }
    return this;
  }

  /**
   * Filter by date range (RethinkDB-style between)
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {Object} options - Options (leftBound, rightBound)
   * @returns {QueryBuilder} This instance for chaining
   */
  between(startDate, endDate, options = {}) {
    const leftOp = options.leftBound === 'open' ? '>' : '>=';
    const rightOp = options.rightBound === 'open' ? '<' : '<=';
    
    this._addWhereCondition('created_on', leftOp, startDate);
    this._addWhereCondition('created_on', rightOp, endDate);
    
    return this;
  }

  /**
   * Filter by array contains (for PostgreSQL arrays)
   * @param {string} field - Field name
   * @param {*} value - Value to check for
   * @returns {QueryBuilder} This instance for chaining
   */
  contains(field, value) {
    const placeholder = `$${this._paramIndex++}`;
    this._where.push(`${field} @> ARRAY[${placeholder}]::text[]`);
    this._params.push(value);
    return this;
  }

  /**
   * Filter by JSONB field contains
   * @param {string} field - JSONB field name
   * @param {Object} value - Value to check for
   * @returns {QueryBuilder} This instance for chaining
   */
  containsJsonb(field, value) {
    const placeholder = `$${this._paramIndex++}`;
    this._where.push(`${field} @> ${placeholder}`);
    this._params.push(JSON.stringify(value));
    return this;
  }

  /**
   * Filter by field existence in JSONB
   * @param {string} field - JSONB field name
   * @param {string} key - Key to check for existence
   * @returns {QueryBuilder} This instance for chaining
   */
  hasFields(field, key) {
    const placeholder = `$${this._paramIndex++}`;
    this._where.push(`${field} ? ${placeholder}`);
    this._params.push(key);
    return this;
  }

  /**
   * Filter using a function-like syntax (limited RethinkDB compatibility)
   * @param {Function} filterFunc - Filter function
   * @returns {QueryBuilder} This instance for chaining
   */
  filterFunction(filterFunc) {
    // This is a simplified implementation for common patterns
    const funcStr = filterFunc.toString();
    
    // Handle row => row.field.eq(value) patterns
    const eqMatch = funcStr.match(/row\s*=>\s*row\.(\w+)\.eq\(([^)]+)\)/);
    if (eqMatch) {
      const field = eqMatch[1];
      const value = eqMatch[2].replace(/['"]/g, ''); // Remove quotes
      this._addWhereCondition(field, '=', value);
      return this;
    }
    
    // Handle row => row.field.ne(value) patterns
    const neMatch = funcStr.match(/row\s*=>\s*row\.(\w+)\.ne\(([^)]+)\)/);
    if (neMatch) {
      const field = neMatch[1];
      const value = neMatch[2].replace(/['"]/g, '');
      this._addWhereCondition(field, '!=', value);
      return this;
    }
    
    // Handle row => ids.includes(row.id) patterns
    const includesMatch = funcStr.match(/(\w+)\.includes\(row\.(\w+)\)/);
    if (includesMatch) {
      const field = includesMatch[2];
      // This would need the array to be passed separately
      debug.db('Warning: includes pattern detected but array not available');
      return this;
    }
    
    debug.db(`Warning: Unsupported filter function pattern: ${funcStr}`);
    return this;
  }

  /**
   * Get all revisions of a specific document (including old and deleted)
   * @param {string} documentId - The document ID to get revisions for
   * @returns {QueryBuilder} This instance for chaining
   */
  getAllRevisions(documentId) {
    // Clear any existing revision filters
    this._where = this._where.filter(condition => 
      !condition.includes('_old_rev_of') && !condition.includes('_rev_deleted')
    );
    
    // Add condition to get all revisions of the document
    const placeholder1 = `$${this._paramIndex++}`;
    const placeholder2 = `$${this._paramIndex++}`;
    this._where.push(`(id = ${placeholder1} OR _old_rev_of = ${placeholder2})`);
    this._params.push(documentId, documentId);
    
    return this;
  }

  /**
   * Add ORDER BY clause
   * @param {string} field - Field to order by
   * @param {string} direction - Sort direction (ASC/DESC)
   * @returns {QueryBuilder} This instance for chaining
   */
  orderBy(field, direction = 'ASC') {
    this._orderBy.push(`${field} ${direction.toUpperCase()}`);
    return this;
  }

  /**
   * Add LIMIT clause
   * @param {number} count - Limit count
   * @returns {QueryBuilder} This instance for chaining
   */
  limit(count) {
    this._limit = count;
    return this;
  }

  /**
   * Add OFFSET clause
   * @param {number} count - Offset count
   * @returns {QueryBuilder} This instance for chaining
   */
  offset(count) {
    this._offset = count;
    return this;
  }

  /**
   * Add JOIN clauses with support for complex RethinkDB-style joins
   * @param {Object} joinSpec - Join specification
   * @returns {QueryBuilder} This instance for chaining
   */
  getJoin(joinSpec) {
    if (!joinSpec || Object.keys(joinSpec).length === 0) {
      return this;
    }
    
    // Store join specification for processing during query execution
    if (!this._joinSpecs) {
      this._joinSpecs = [];
    }
    this._joinSpecs.push(joinSpec);
    
    // Process joins and add to query
    for (const [relationName, relationSpec] of Object.entries(joinSpec)) {
      this._processJoin(relationName, relationSpec);
    }
    
    return this;
  }

  /**
   * Process a single join specification
   * @param {string} relationName - Name of the relation
   * @param {Object|boolean} relationSpec - Join specification
   * @private
   */
  _processJoin(relationName, relationSpec) {
    // Handle simple boolean joins (e.g., { teams: true })
    if (relationSpec === true) {
      this._addSimpleJoin(relationName);
      return;
    }
    
    // Handle complex join specifications
    if (typeof relationSpec === 'object' && relationSpec !== null) {
      this._addComplexJoin(relationName, relationSpec);
      return;
    }
  }

  /**
   * Add a simple join for a relation
   * @param {string} relationName - Name of the relation
   * @private
   */
  _addSimpleJoin(relationName) {
    const joinInfo = this._getJoinInfo(relationName);
    if (!joinInfo) {
      debug.db(`Warning: Unknown relation '${relationName}' for table '${this.tableName}'`);
      return;
    }
    
    // Handle joins that require intermediate join tables
    if (joinInfo.requiresJoinTable) {
      const joinTableName = this._getTableName(joinInfo.requiresJoinTable);
      // Add the intermediate join table first
      if (relationName === 'teams' && this.tableName.includes('users')) {
        this._joins.push(`LEFT JOIN ${joinTableName} ON ${this.tableName}.id = ${joinTableName}.user_id`);
        this._joins.push(`LEFT JOIN ${joinInfo.table} ON ${joinTableName}.team_id = ${joinInfo.table}.id`);
      } else if (relationName === 'members' && this.tableName.includes('teams')) {
        this._joins.push(`LEFT JOIN ${joinTableName} ON ${this.tableName}.id = ${joinTableName}.team_id`);
        this._joins.push(`LEFT JOIN ${joinInfo.table} ON ${joinTableName}.user_id = ${joinInfo.table}.id`);
      } else {
        // Generic case
        this._joins.push(`LEFT JOIN ${joinTableName} ON ${this._buildJoinTableCondition(joinInfo, joinTableName)}`);
        this._joins.push(`LEFT JOIN ${joinInfo.table} ON ${joinInfo.condition}`);
      }
    } else {
      // Direct join
      let joinClause = `LEFT JOIN ${joinInfo.table} ON ${joinInfo.condition}`;
      
      // Add revision filtering for joined table if it has revision fields
      if (joinInfo.hasRevisions) {
        joinClause += ` AND ${joinInfo.table}._old_rev_of IS NULL AND (${joinInfo.table}._rev_deleted IS NULL OR ${joinInfo.table}._rev_deleted = false)`;
      }
      
      this._joins.push(joinClause);
    }
    
    // Mark this relation for result processing
    if (!this._simpleJoins) {
      this._simpleJoins = {};
    }
    this._simpleJoins[relationName] = joinInfo;
  }

  /**
   * Add a complex join with filters and transformations
   * @param {string} relationName - Name of the relation
   * @param {Object} relationSpec - Join specification with _apply, filters, etc.
   * @private
   */
  _addComplexJoin(relationName, relationSpec) {
    const joinInfo = this._getJoinInfo(relationName);
    if (!joinInfo) {
      debug.db(`Warning: Unknown relation '${relationName}' for table '${this.tableName}'`);
      return;
    }
    
    // For complex joins, we'll need to handle them during result processing
    // Store the specification for later use
    if (!this._complexJoins) {
      this._complexJoins = {};
    }
    this._complexJoins[relationName] = {
      ...relationSpec,
      joinInfo
    };
  }

  /**
   * Build join table condition for many-to-many relationships
   * @param {Object} joinInfo - Join information
   * @param {string} joinTableName - Name of the join table
   * @returns {string} Join condition
   * @private
   */
  _buildJoinTableCondition(joinInfo, joinTableName) {
    // Extract the main table part from the full condition
    const parts = joinInfo.condition.split(' AND ');
    return parts[0]; // Return the first part which should be the join table condition
  }

  /**
   * Get join information for a relation name
   * @param {string} relationName - Name of the relation
   * @returns {Object|null} Join information
   * @private
   */
  _getJoinInfo(relationName) {
    // Define common join patterns based on model relationships
    const joinMappings = {
      // User relations
      teams: {
        table: this._getTableName('teams'),
        condition: `${this.tableName}.id = team_members.user_id AND team_members.team_id = ${this._getTableName('teams')}.id`,
        hasRevisions: true,
        requiresJoinTable: 'team_members'
      },
      moderatorOf: {
        table: this._getTableName('teams'),
        condition: `${this.tableName}.id = team_moderators.user_id AND team_moderators.team_id = ${this._getTableName('teams')}.id`,
        hasRevisions: true,
        requiresJoinTable: 'team_moderators'
      },
      meta: {
        table: this._getTableName('user_metas'),
        condition: `${this.tableName}.user_meta_id = ${this._getTableName('user_metas')}.id`,
        hasRevisions: false
      },
      
      // Thing relations
      reviews: {
        table: this._getTableName('reviews'),
        condition: `${this.tableName}.id = ${this._getTableName('reviews')}.thing_id`,
        hasRevisions: true
      },
      files: {
        table: this._getTableName('files'),
        condition: `${this.tableName}.id = thing_files.thing_id AND thing_files.file_id = ${this._getTableName('files')}.id`,
        hasRevisions: true,
        requiresJoinTable: 'thing_files'
      },
      
      // Review relations
      thing: {
        table: this._getTableName('things'),
        condition: `${this.tableName}.thing_id = ${this._getTableName('things')}.id`,
        hasRevisions: true
      },
      creator: {
        table: this._getTableName('users'),
        condition: `${this.tableName}.created_by = ${this._getTableName('users')}.id`,
        hasRevisions: false
      },
      socialImage: {
        table: this._getTableName('files'),
        condition: `${this.tableName}.social_image_id = ${this._getTableName('files')}.id`,
        hasRevisions: true
      },
      
      // Team relations
      members: {
        table: this._getTableName('users'),
        condition: `${this.tableName}.id = team_members.team_id AND team_members.user_id = ${this._getTableName('users')}.id`,
        hasRevisions: false,
        requiresJoinTable: 'team_members'
      },
      moderators: {
        table: this._getTableName('users'),
        condition: `${this.tableName}.id = team_moderators.team_id AND team_moderators.user_id = ${this._getTableName('users')}.id`,
        hasRevisions: false,
        requiresJoinTable: 'team_moderators'
      },
      
      // File relations
      uploader: {
        table: this._getTableName('users'),
        condition: `${this.tableName}.uploaded_by = ${this._getTableName('users')}.id`,
        hasRevisions: false
      },
      things: {
        table: this._getTableName('things'),
        condition: `${this.tableName}.id = thing_files.file_id AND thing_files.thing_id = ${this._getTableName('things')}.id`,
        hasRevisions: true,
        requiresJoinTable: 'thing_files'
      }
    };
    
    return joinMappings[relationName] || null;
  }

  /**
   * Get table name with optional prefix
   * @param {string} baseName - Base table name
   * @returns {string} Full table name
   * @private
   */
  _getTableName(baseName) {
    const prefix = this.dal.tablePrefix || '';
    return prefix + baseName;
  }

  /**
   * Execute query and return all results
   * @returns {Promise<Array>} Query results
   */
  async run() {
    try {
      // Handle complex joins that require separate queries
      if (this._complexJoins && Object.keys(this._complexJoins).length > 0) {
        return await this._runWithComplexJoins();
      }
      
      const query = this._buildSelectQuery();
      const result = await this.dal.query(query, this._params);
      
      // Process results with simple joins
      return await this._processResults(result.rows);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Execute query with complex joins that require separate queries
   * @returns {Promise<Array>} Query results with joined data
   * @private
   */
  async _runWithComplexJoins() {
    // First get the main results
    const mainQuery = this._buildSelectQuery();
    const mainResult = await this.dal.query(mainQuery, this._params);
    const mainRows = await this._processResults(mainResult.rows);
    
    // Process each complex join
    for (const [relationName, joinSpec] of Object.entries(this._complexJoins)) {
      await this._processComplexJoin(mainRows, relationName, joinSpec);
    }
    
    return mainRows;
  }

  /**
   * Process a complex join by executing separate queries
   * @param {Array} mainRows - Main query results
   * @param {string} relationName - Name of the relation
   * @param {Object} joinSpec - Join specification
   * @private
   */
  async _processComplexJoin(mainRows, relationName, joinSpec) {
    if (mainRows.length === 0) return;
    
    const { joinInfo } = joinSpec;
    const mainIds = mainRows.map(row => row.id);
    
    // Build query for the related data
    let relatedQuery = `SELECT * FROM ${joinInfo.table}`;
    let relatedParams = [];
    let paramIndex = 1;
    
    // Add join conditions
    if (relationName === 'reviews' && this.tableName.includes('things')) {
      relatedQuery += ` WHERE thing_id = ANY(${paramIndex})`;
      relatedParams.push(mainIds);
      paramIndex++;
    } else if (relationName === 'files' && this.tableName.includes('things')) {
      relatedQuery = `
        SELECT f.* FROM ${joinInfo.table} f
        JOIN thing_files tf ON f.id = tf.file_id
        WHERE tf.thing_id = ANY(${paramIndex})
      `;
      relatedParams.push(mainIds);
      paramIndex++;
    } else if (relationName === 'teams' && this.tableName.includes('users')) {
      relatedQuery = `
        SELECT t.* FROM ${joinInfo.table} t
        JOIN team_members tm ON t.id = tm.team_id
        WHERE tm.user_id = ANY(${paramIndex})
      `;
      relatedParams.push(mainIds);
      paramIndex++;
    }
    
    // Add revision filtering
    if (joinInfo.hasRevisions) {
      relatedQuery += ` AND _old_rev_of IS NULL AND (_rev_deleted IS NULL OR _rev_deleted = false)`;
    }
    
    // Apply _apply transformations
    if (joinSpec._apply) {
      // Handle common _apply patterns
      if (joinSpec._apply.toString().includes('without(\'password\')')) {
        // Remove password field from select
        relatedQuery = relatedQuery.replace('SELECT *', 'SELECT id, display_name, canonical_name, email, user_meta_id, invite_link_count, registration_date, show_error_details, is_trusted, is_site_moderator, is_super_user, suppressed_notices, prefers_rich_text_editor');
      }
      
      // Handle ordering
      if (joinSpec._apply.toString().includes('orderBy')) {
        if (joinSpec._apply.toString().includes('desc(\'createdOn\')')) {
          relatedQuery += ' ORDER BY created_on DESC';
        } else if (joinSpec._apply.toString().includes('desc(\'created_on\')')) {
          relatedQuery += ' ORDER BY created_on DESC';
        }
      }
      
      // Handle filtering
      if (joinSpec._apply.toString().includes('filter')) {
        if (joinSpec._apply.toString().includes('completed: true')) {
          relatedQuery += ' AND completed = true';
        }
        if (joinSpec._apply.toString().includes('_revDeleted: false')) {
          relatedQuery += ' AND (_rev_deleted IS NULL OR _rev_deleted = false)';
        }
      }
      
      // Handle limits
      if (joinSpec._apply.toString().includes('limit(')) {
        const limitMatch = joinSpec._apply.toString().match(/limit\((\d+)\)/);
        if (limitMatch) {
          relatedQuery += ` LIMIT ${limitMatch[1]}`;
        }
      }
    }
    
    // Execute the related query
    const relatedResult = await this.dal.query(relatedQuery, relatedParams);
    
    // Group related results by the foreign key
    const relatedByKey = {};
    for (const relatedRow of relatedResult.rows) {
      let foreignKey;
      if (relationName === 'reviews') {
        foreignKey = relatedRow.thing_id;
      } else if (relationName === 'files') {
        // This would need to be handled differently for many-to-many
        continue;
      } else if (relationName === 'teams') {
        // This would need to be handled differently for many-to-many
        continue;
      } else {
        continue;
      }
      
      if (!relatedByKey[foreignKey]) {
        relatedByKey[foreignKey] = [];
      }
      relatedByKey[foreignKey].push(relatedRow);
    }
    
    // Attach related data to main rows
    for (const mainRow of mainRows) {
      const relatedData = relatedByKey[mainRow.id] || [];
      mainRow[relationName] = relatedData.map(row => {
        // Create model instances for related data
        const RelatedModel = this._getRelatedModel(relationName);
        return RelatedModel ? RelatedModel._createInstance(row) : row;
      });
    }
  }

  /**
   * Get the model class for a relation
   * @param {string} relationName - Name of the relation
   * @returns {Function|null} Model class
   * @private
   */
  _getRelatedModel(relationName) {
    // This would ideally use a model registry
    // For now, return null and use raw data
    return null;
  }

  /**
   * Process query results, handling simple joins
   * @param {Array} rows - Raw database rows
   * @returns {Promise<Array>} Processed model instances
   * @private
   */
  async _processResults(rows) {
    if (!this._simpleJoins || Object.keys(this._simpleJoins).length === 0) {
      // No joins, just create model instances
      return rows.map(row => this.modelClass._createInstance(row));
    }
    
    // Process rows with joined data
    const processedRows = [];
    for (const row of rows) {
      const mainData = {};
      const joinedData = {};
      
      // Separate main data from joined data
      for (const [key, value] of Object.entries(row)) {
        let isJoinedField = false;
        for (const relationName of Object.keys(this._simpleJoins)) {
          if (key.startsWith(`${relationName}_`)) {
            if (!joinedData[relationName]) {
              joinedData[relationName] = {};
            }
            const fieldName = key.substring(relationName.length + 1);
            joinedData[relationName][fieldName] = value;
            isJoinedField = true;
            break;
          }
        }
        
        if (!isJoinedField) {
          mainData[key] = value;
        }
      }
      
      // Create main model instance
      const instance = this.modelClass._createInstance(mainData);
      
      // Attach joined data
      for (const [relationName, data] of Object.entries(joinedData)) {
        if (data && Object.keys(data).some(key => data[key] !== null)) {
          // Create model instance for joined data if possible
          const RelatedModel = this._getRelatedModel(relationName);
          instance[relationName] = RelatedModel ? RelatedModel._createInstance(data) : data;
        } else {
          instance[relationName] = null;
        }
      }
      
      processedRows.push(instance);
    }
    
    return processedRows;
  }

  /**
   * Execute query and return first result
   * @returns {Promise<Model|null>} First result or null
   */
  async first() {
    this.limit(1);
    const results = await this.run();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return count
   * @returns {Promise<number>} Result count
   */
  async count() {
    try {
      const query = this._buildCountQuery();
      const result = await this.dal.query(query, this._params);
      
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Delete records matching the query
   * @returns {Promise<Object>} Delete result
   */
  async delete() {
    try {
      const query = this._buildDeleteQuery();
      return await this.dal.query(query, this._params);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Delete a record by ID
   * @param {string} id - Record ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteById(id) {
    try {
      const query = `DELETE FROM ${this.tableName} WHERE id = $1`;
      return await this.dal.query(query, [id]);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }  /**
   
* Add a WHERE condition
   * @param {string} field - Field name
   * @param {string} operator - Comparison operator
   * @param {*} value - Comparison value
   * @private
   */
  _addWhereCondition(field, operator, value) {
    if (operator === 'IS' && value === null) {
      this._where.push(`${field} IS NULL`);
    } else if (operator === 'IS NOT' && value === null) {
      this._where.push(`${field} IS NOT NULL`);
    } else {
      const placeholder = `$${this._paramIndex++}`;
      this._where.push(`${field} ${operator} ${placeholder}`);
      this._params.push(value);
    }
  }

  /**
   * Build SELECT query
   * @returns {string} SQL query
   * @private
   */
  _buildSelectQuery() {
    // Use qualified column names when we have joins
    let selectClause = this._select.join(', ');
    if (this._joins.length > 0 && this._select.includes('*')) {
      // Replace * with qualified main table columns to avoid ambiguity
      selectClause = `${this.tableName}.*`;
    }
    
    let query = `SELECT ${selectClause} FROM ${this.tableName}`;
    
    // Add JOINs
    if (this._joins.length > 0) {
      query += ' ' + this._joins.join(' ');
    }
    
    // Add WHERE clause with qualified column names
    if (this._where.length > 0) {
      const qualifiedWhere = this._where.map(condition => {
        // Qualify column names that don't already have table prefixes
        if (!condition.includes('.') && !condition.includes('(')) {
          // Simple column references - qualify with main table name
          return condition.replace(/^(\w+)/, `${this.tableName}.$1`);
        }
        return condition;
      });
      query += ' WHERE ' + qualifiedWhere.join(' AND ');
    }
    
    // Add ORDER BY with qualified column names
    if (this._orderBy.length > 0) {
      const qualifiedOrderBy = this._orderBy.map(orderClause => {
        // Qualify column names in ORDER BY
        return orderClause.replace(/^(\w+)/, `${this.tableName}.$1`);
      });
      query += ' ORDER BY ' + qualifiedOrderBy.join(', ');
    }
    
    // Add LIMIT
    if (this._limit !== null) {
      query += ` LIMIT ${this._limit}`;
    }
    
    // Add OFFSET
    if (this._offset !== null) {
      query += ` OFFSET ${this._offset}`;
    }
    
    return query;
  }

  /**
   * Build COUNT query
   * @returns {string} SQL query
   * @private
   */
  _buildCountQuery() {
    let query = `SELECT COUNT(*) as count FROM ${this.tableName}`;
    
    // Add WHERE clause
    if (this._where.length > 0) {
      query += ' WHERE ' + this._where.join(' AND ');
    }
    
    return query;
  }

  /**
   * Build DELETE query
   * @returns {string} SQL query
   * @private
   */
  _buildDeleteQuery() {
    let query = `DELETE FROM ${this.tableName}`;
    
    // Add WHERE clause
    if (this._where.length > 0) {
      query += ' WHERE ' + this._where.join(' AND ');
    }
    
    return query;
  }

  /**
   * Get a random sample of records
   * 
   * @param {Number} count - Number of records to sample
   * @returns {Promise<Array>} Array of sampled records
   */
  async sample(count = 1) {
    // Add ORDER BY RANDOM() and LIMIT to get random sample
    this._orderBy = ['RANDOM()'];
    this._limit = count;
    
    const results = await this.run();
    return results;
  }
}

module.exports = QueryBuilder;
