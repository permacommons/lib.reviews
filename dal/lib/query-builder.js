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
        this._addWhereCondition(key, '=', value);
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
  }  /**

   * Add JOIN clauses (simplified implementation)
   * @param {Object} joinSpec - Join specification
   * @returns {QueryBuilder} This instance for chaining
   */
  getJoin(joinSpec) {
    if (!joinSpec || Object.keys(joinSpec).length === 0) {
      return this;
    }
    
    // Store join specification for processing during query building
    this._joinSpec = joinSpec;
    
    // Process joins and add to query
    for (const [relationName, relationSpec] of Object.entries(joinSpec)) {
      this._processJoin(relationName, relationSpec);
    }
    
    return this;
  }

  /**
   * Process a single join specification
   * @param {string} relationName - Name of the relation
   * @param {Object} relationSpec - Join specification
   * @private
   */
  _processJoin(relationName, relationSpec) {
    // This is a simplified join implementation
    // In a full implementation, this would use model relationship definitions
    
    if (typeof relationSpec === 'object' && relationSpec.tableName) {
      const joinTable = relationSpec.tableName;
      const joinCondition = relationSpec.on || `${this.tableName}.${relationName}_id = ${joinTable}.id`;
      
      // Add revision-aware join condition for joined table
      let joinClause = `LEFT JOIN ${joinTable} ON ${joinCondition}`;
      
      // If the joined table has revision fields, filter for current revisions
      if (relationSpec.hasRevisions !== false) {
        joinClause += ` AND ${joinTable}._old_rev_of IS NULL AND ${joinTable}._rev_deleted = false`;
      }
      
      this._joins.push(joinClause);
      
      // Update select to include joined fields with aliases
      if (relationSpec.select) {
        const joinedFields = relationSpec.select.map(field => 
          `${joinTable}.${field} AS ${relationName}_${field}`
        );
        this._select = this._select.concat(joinedFields);
      }
    }
  }

  /**
   * Execute query and return all results
   * @returns {Promise<Array>} Query results
   */
  async run() {
    try {
      const query = this._buildSelectQuery();
      const result = await this.dal.query(query, this._params);
      
      return result.rows.map(row => this.modelClass._createInstance(row));
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
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
    let query = `SELECT ${this._select.join(', ')} FROM ${this.tableName}`;
    
    // Add JOINs (simplified)
    if (this._joins.length > 0) {
      query += ' ' + this._joins.join(' ');
    }
    
    // Add WHERE clause
    if (this._where.length > 0) {
      query += ' WHERE ' + this._where.join(' AND ');
    }
    
    // Add ORDER BY
    if (this._orderBy.length > 0) {
      query += ' ORDER BY ' + this._orderBy.join(', ');
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
}

module.exports = QueryBuilder;