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
    this._addWhereCondition('_rev_tags', '&&', tagArray);

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
    const values = Array.isArray(value) ? value : [value];
    this._addWhereCondition(field, '@>', values, {
      cast: 'text[]'
    });
    return this;
  }

  /**
   * Filter by JSONB field contains
   * @param {string} field - JSONB field name
   * @param {Object} value - Value to check for
   * @returns {QueryBuilder} This instance for chaining
   */
  containsJsonb(field, value) {
    this._addWhereCondition(field, '@>', value, {
      cast: 'jsonb',
      serializeValue: JSON.stringify
    });
    return this;
  }

  /**
   * Filter by field existence in JSONB
   * @param {string} field - JSONB field name
   * @param {string} key - Key to check for existence
   * @returns {QueryBuilder} This instance for chaining
   */
  hasFields(field, key) {
    this._addWhereCondition(field, '?', key);
    return this;
  }

  /**
   * Filter by membership in a list of values using PostgreSQL ANY
   * @param {string} field - Field name
   * @param {Array} values - Values to match
   * @param {Object} [options] - Additional options
   * @param {string} [options.cast] - Optional cast to apply to the parameter (e.g., 'uuid[]')
   * @returns {QueryBuilder} This instance for chaining
   */
  whereIn(field, values, { cast } = {}) {
    if (!Array.isArray(values) || values.length === 0) {
      return this;
    }

    const valueTransform = placeholder => `(${placeholder}${cast ? `::${cast}` : ''})`;
    this._addWhereCondition(field, '= ANY', values, { valueTransform });
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
    this._where = this._where.filter(predicate => !this._isRevisionFilterPredicate(predicate));

    // Add condition to get all revisions of the document
    const idPredicate = this._createPredicate('id', '=', documentId);
    const oldRevPredicate = this._createPredicate('_old_rev_of', '=', documentId);
    this._where.push({
      type: 'group',
      conjunction: 'OR',
      predicates: [idPredicate, oldRevPredicate]
    });

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

    if (joinInfo.joinTable && joinInfo.joinTableOn) {
      this._joins.push(`LEFT JOIN ${joinInfo.joinTable} ON ${joinInfo.joinTableOn}`);

      let targetJoin = `LEFT JOIN ${joinInfo.table} ON ${joinInfo.condition}`;
      if (joinInfo.hasRevisions) {
        targetJoin += ` AND ${joinInfo.table}._old_rev_of IS NULL AND (${joinInfo.table}._rev_deleted IS NULL OR ${joinInfo.table}._rev_deleted = false)`;
      }

      this._joins.push(targetJoin);
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
   * Get join information for a relation name
   * @param {string} relationName - Name of the relation
   * @returns {Object|null} Join information
   * @private
   */
  _getJoinInfo(relationName) {
    if (!this.modelClass || typeof this.modelClass.getRelation !== 'function') {
      return null;
    }

    const relationConfig = this.modelClass.getRelation(relationName);
    if (!relationConfig) {
      return null;
    }

    const baseTargetTable = relationConfig.targetTable || relationConfig.table;
    const targetTableName = this._resolveTableReference(baseTargetTable);
    if (!targetTableName) {
      debug.db(`Warning: Relation '${relationName}' on '${this.tableName}' is missing a target table definition`);
      return null;
    }

    const hasRevisions = Boolean(relationConfig.hasRevisions);
    const sourceColumn = relationConfig.sourceColumn || relationConfig.sourceKey || 'id';
    const targetColumn = relationConfig.targetColumn || relationConfig.targetKey || 'id';
    const cardinality = relationConfig.cardinality || (relationConfig.isArray ? 'many' : 'one');
    const targetModelKey = relationConfig.targetModelKey || relationConfig.targetModel || baseTargetTable;

    if (relationConfig.through && typeof relationConfig.through === 'object') {
      const joinTableName = this._resolveTableReference(relationConfig.through.table || relationConfig.joinTable);
      if (!joinTableName) {
        debug.db(`Warning: Relation '${relationName}' on '${this.tableName}' is missing a join table definition`);
        return null;
      }

      const throughSourceKey = relationConfig.through.sourceColumn
        || relationConfig.through.sourceForeignKey
        || relationConfig.through.sourceKey;
      const throughTargetKey = relationConfig.through.targetColumn
        || relationConfig.through.targetForeignKey
        || relationConfig.through.targetKey;

      if (!throughSourceKey || !throughTargetKey) {
        debug.db(`Warning: Relation '${relationName}' on '${this.tableName}' is missing join column metadata`);
        return null;
      }

      const joinTableOn = relationConfig.through.sourceCondition
        || `${this.tableName}.${sourceColumn} = ${joinTableName}.${throughSourceKey}`;
      const targetCondition = relationConfig.condition
        || relationConfig.through.targetCondition
        || `${joinTableName}.${throughTargetKey} = ${targetTableName}.${targetColumn}`;

      return {
        type: 'through',
        table: targetTableName,
        baseTable: baseTargetTable,
        hasRevisions,
        joinTable: joinTableName,
        joinTableOn,
        condition: targetCondition,
        sourceColumn,
        targetColumn,
        joinTableSourceColumn: throughSourceKey,
        joinTableTargetColumn: throughTargetKey,
        cardinality,
        isArray: cardinality !== 'one',
        targetModelKey
      };
    }

    const directCondition = relationConfig.condition
      || `${this.tableName}.${sourceColumn} = ${targetTableName}.${targetColumn}`;

    return {
      type: 'direct',
      table: targetTableName,
      baseTable: baseTargetTable,
      hasRevisions,
      condition: directCondition,
      sourceColumn,
      targetColumn,
      cardinality,
      isArray: cardinality !== 'one',
      targetModelKey
    };
  }

  _resolveTableReference(tableRef) {
    if (!tableRef || typeof tableRef !== 'string') {
      return null;
    }

    if (tableRef.includes('.')) {
      return tableRef;
    }

    return this._getTableName(tableRef);
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

      const { sql, params } = this._buildSelectQuery();
      const result = await this.dal.query(sql, params);
      
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
    const mainResult = await this.dal.query(mainQuery.sql, mainQuery.params);
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
    if (!Array.isArray(mainRows) || mainRows.length === 0) {
      return;
    }

    const { joinInfo } = joinSpec;
    if (!joinInfo) {
      debug.db(`Warning: Missing join metadata for relation '${relationName}' on '${this.tableName}'`);
      return;
    }

    const sourceValues = this._extractJoinSourceValues(mainRows, joinInfo.sourceColumn);
    if (sourceValues.length === 0) {
      this._assignJoinResults(mainRows, relationName, joinInfo, new Map());
      return;
    }

    const analysis = this._analyzeJoinApply(joinSpec._apply);
    const { query, params, joinSourceAlias } = this._buildComplexJoinQuery(
      relationName,
      joinInfo,
      sourceValues,
      analysis
    );

    const relatedResult = await this.dal.query(query, params);
    let relatedRows = relatedResult.rows || [];

    if (analysis?.removeFields?.length) {
      relatedRows = this._applyJoinFieldOmissions(relatedRows, analysis.removeFields);
    }

    const groupedRows = this._groupRelatedRows(relatedRows, joinSourceAlias);
    this._assignJoinResults(mainRows, relationName, joinInfo, groupedRows);
  }

  _extractJoinSourceValues(mainRows, sourceColumn) {
    if (!sourceColumn) {
      return [];
    }

    const values = [];
    const seen = new Set();
    for (const row of mainRows) {
      const value = this._getRowValue(row, sourceColumn);
      if (value === undefined || value === null) {
        continue;
      }

      const key = value instanceof Date ? value.getTime() : `${value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      values.push(value);
    }

    return values;
  }

  _buildComplexJoinQuery(relationName, joinInfo, sourceValues, analysis = null) {
    const params = [sourceValues];
    let paramIndex = 2;

    const targetAlias = `${relationName}_target`;
    const throughAlias = `${relationName}_through`;
    const joinSourceAlias = '_join_source_id';

    const whereClauses = [];
    let orderClause = '';
    let limitClause = '';

    let query;
    if (joinInfo.type === 'through') {
      query = `
        SELECT ${targetAlias}.*, ${throughAlias}.${joinInfo.joinTableSourceColumn} AS ${joinSourceAlias}
        FROM ${joinInfo.table} ${targetAlias}
        JOIN ${joinInfo.joinTable} ${throughAlias}
          ON ${throughAlias}.${joinInfo.joinTableTargetColumn} = ${targetAlias}.${joinInfo.targetColumn}
      `;
      whereClauses.push(`${throughAlias}.${joinInfo.joinTableSourceColumn} = ANY($1)`);
    } else {
      query = `
        SELECT ${targetAlias}.*, ${targetAlias}.${joinInfo.targetColumn} AS ${joinSourceAlias}
        FROM ${joinInfo.table} ${targetAlias}
      `;
      whereClauses.push(`${targetAlias}.${joinInfo.targetColumn} = ANY($1)`);
    }

    if (joinInfo.hasRevisions) {
      whereClauses.push(`${targetAlias}._old_rev_of IS NULL`);
      whereClauses.push(`(${targetAlias}._rev_deleted IS NULL OR ${targetAlias}._rev_deleted = false)`);
    }

    if (analysis?.filters?.length) {
      for (const filter of analysis.filters) {
        const column = this._normalizeColumnName(filter.field);
        if (column === '_rev_deleted' && filter.value === false) {
          whereClauses.push(`(${targetAlias}._rev_deleted IS NULL OR ${targetAlias}._rev_deleted = false)`);
          continue;
        }

        if (filter.operator === 'IS NULL' || filter.value === null) {
          whereClauses.push(`${targetAlias}.${column} IS NULL`);
          continue;
        }

        if (filter.operator === 'IS NOT NULL') {
          whereClauses.push(`${targetAlias}.${column} IS NOT NULL`);
          continue;
        }

        const operator = filter.operator || '=';
        whereClauses.push(`${targetAlias}.${column} ${operator} $${paramIndex}`);
        params.push(filter.value);
        paramIndex++;
      }
    }

    if (analysis?.order) {
      const column = this._normalizeColumnName(analysis.order.field);
      orderClause = ` ORDER BY ${targetAlias}.${column} ${analysis.order.direction}`;
    }

    if (typeof analysis?.limit === 'number') {
      limitClause = ` LIMIT ${analysis.limit}`;
    }

    const whereClause = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `${query.trim()}${whereClause}${orderClause}${limitClause}`;

    return { query: sql, params, joinSourceAlias };
  }

  _groupRelatedRows(rows, joinSourceAlias = '_join_source_id') {
    const grouped = new Map();
    if (!Array.isArray(rows)) {
      return grouped;
    }

    for (const row of rows) {
      if (!row || typeof row !== 'object' || !Object.prototype.hasOwnProperty.call(row, joinSourceAlias)) {
        continue;
      }

      const key = row[joinSourceAlias];
      if (key === undefined || key === null) {
        continue;
      }

      const cloned = { ...row };
      delete cloned[joinSourceAlias];

      const existing = grouped.get(key) || [];
      existing.push(cloned);
      grouped.set(key, existing);
    }

    return grouped;
  }

  _assignJoinResults(mainRows, relationName, joinInfo, groupedRows) {
    const RelatedModel = this._getRelatedModel(relationName, joinInfo);
    const expectsArray = joinInfo.isArray !== false && joinInfo.cardinality !== 'one';
    const sourceColumn = joinInfo.sourceColumn || 'id';

    for (const mainRow of mainRows) {
      const joinKey = this._getRowValue(mainRow, sourceColumn);
      const related = joinKey === undefined || joinKey === null
        ? []
        : (groupedRows.get(joinKey) || []);

      if (expectsArray) {
        mainRow[relationName] = related.map(row => (
          RelatedModel ? RelatedModel._createInstance(row) : row
        ));
      } else {
        const match = related[0] || null;
        mainRow[relationName] = match ? (
          RelatedModel ? RelatedModel._createInstance(match) : match
        ) : null;
      }
    }
  }

  _getRowValue(row, column) {
    if (!row || !column) {
      return undefined;
    }

    if (typeof row.getValue === 'function') {
      return row.getValue(column);
    }

    return row[column];
  }

  _applyJoinFieldOmissions(rows, fields) {
    if (!Array.isArray(rows) || !Array.isArray(fields) || fields.length === 0) {
      return rows;
    }

    return rows.map(row => {
      if (!row || typeof row !== 'object') {
        return row;
      }

      const cloned = { ...row };
      for (const field of fields) {
        if (!field) continue;
        delete cloned[field];
      }
      return cloned;
    });
  }

  _analyzeJoinApply(applyFn) {
    if (typeof applyFn !== 'function') {
      return null;
    }

    const source = applyFn.toString();
    const analysis = {
      removeFields: [],
      filters: []
    };

    const withoutRegex = /without\(([^)]+)\)/g;
    let withoutMatch;
    while ((withoutMatch = withoutRegex.exec(source)) !== null) {
      const fields = withoutMatch[1]
        .split(',')
        .map(entry => entry.replace(/['"\[\]\s]/g, ''))
        .filter(Boolean);
      analysis.removeFields.push(...fields);
    }

    const limitMatch = source.match(/limit\((\d+)\)/);
    if (limitMatch) {
      analysis.limit = Number.parseInt(limitMatch[1], 10);
    }

    const descMatch = source.match(/desc\(['"]([\w]+)['"]\)/);
    const ascMatch = source.match(/asc\(['"]([\w]+)['"]\)/);
    const orderByMatch = source.match(/orderBy\(['"]([\w]+)['"]\)/);

    if (descMatch) {
      analysis.order = { field: descMatch[1], direction: 'DESC' };
    } else if (ascMatch) {
      analysis.order = { field: ascMatch[1], direction: 'ASC' };
    } else if (orderByMatch) {
      analysis.order = { field: orderByMatch[1], direction: 'ASC' };
    }

    const filterMatch = source.match(/filter\(\{([^}]*)\}\)/);
    if (filterMatch) {
      const parts = filterMatch[1].split(',');
      for (const part of parts) {
        const [rawField, rawValue] = part.split(':');
        if (!rawField) continue;
        const field = rawField.trim().replace(/['"]/g, '');
        if (!field) continue;

        let value = rawValue ? rawValue.trim() : undefined;
        if (value === undefined || value.length === 0) {
          analysis.filters.push({ field, operator: 'IS NULL', value: null });
          continue;
        }

        value = value.replace(/['"]/g, '');
        if (value.toLowerCase() === 'true') {
          analysis.filters.push({ field, value: true });
        } else if (value.toLowerCase() === 'false') {
          analysis.filters.push({ field, value: false });
        } else if (value.toLowerCase() === 'null') {
          analysis.filters.push({ field, operator: 'IS NULL', value: null });
        } else if (!Number.isNaN(Number(value))) {
          analysis.filters.push({ field, value: Number(value) });
        } else {
          analysis.filters.push({ field, value });
        }
      }
    }

    if (
      analysis.removeFields.length === 0 &&
      analysis.filters.length === 0 &&
      !analysis.order &&
      typeof analysis.limit !== 'number'
    ) {
      return null;
    }

    return analysis;
  }

  _normalizeColumnName(field) {
    if (!field) {
      return field;
    }

    if (field.startsWith('_')) {
      return `_${this._normalizeColumnName(field.slice(1))}`;
    }

    const withUnderscores = field
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_');
    return withUnderscores.toLowerCase();
  }

  /**
   * Get the model class for a relation
   * @param {string} relationName - Name of the relation
   * @returns {Function|null} Model class
   * @private
   */
  _getRelatedModel(relationName, joinInfo = null) {
    const registry = this._getModelRegistry();
    if (!registry || typeof registry.get !== 'function') {
      return null;
    }

    const metadata = joinInfo
      || (this._simpleJoins && this._simpleJoins[relationName])
      || (this._complexJoins && this._complexJoins[relationName]?.joinInfo)
      || {};

    const identifiers = [
      metadata.targetModelKey,
      metadata.baseTable,
      metadata.table,
      relationName
    ];

    for (const identifier of identifiers) {
      if (!identifier) continue;
      const model = registry.get(identifier);
      if (model) {
        return model;
      }
    }

    return null;
  }

  _getModelRegistry() {
    if (!this.dal) {
      return null;
    }

    if (typeof this.dal.getModelRegistry === 'function') {
      return this.dal.getModelRegistry();
    }

    return this.dal.modelRegistry || null;
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
          const joinInfo = this._simpleJoins ? this._simpleJoins[relationName] : null;
          const RelatedModel = this._getRelatedModel(relationName, joinInfo);
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
      const { sql, params } = this._buildCountQuery();
      const result = await this.dal.query(sql, params);
      
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
      const { sql, params } = this._buildDeleteQuery();
      return await this.dal.query(sql, params);
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
  }

  /**
   * Add a WHERE condition
   * @param {string} field - Field name
   * @param {string} operator - Comparison operator
   * @param {*} value - Comparison value
   * @param {Object} [options] - Predicate options
   * @returns {Object} Predicate descriptor
   * @private
   */
  _addWhereCondition(field, operator, value, options = {}) {
    let effectiveOperator = operator;
    if (value === null) {
      if (operator === '=') {
        effectiveOperator = 'IS';
      } else if (operator === '!=') {
        effectiveOperator = 'IS NOT';
      }
    }

    const predicate = this._createPredicate(field, effectiveOperator, value, options);
    this._where.push(predicate);
    return predicate;
  }

  /**
   * Create a predicate descriptor without mutating the WHERE clause
   * @param {string} field - Field reference (optionally qualified)
   * @param {string} operator - Comparison operator
   * @param {*} value - Comparison value
   * @param {Object} options - Predicate options
   * @param {Function} [options.serializeValue] - Serializer for stored value
   * @param {string} [options.cast] - Cast to append to placeholder (e.g., 'jsonb')
   * @param {Function} [options.valueTransform] - Custom placeholder transformer
   * @returns {Object} Predicate descriptor
   * @private
   */
  _createPredicate(field, operator, value, options = {}) {
    const { table: explicitTable, column } = this._splitFieldReference(field);
    const predicate = {
      type: 'basic',
      column,
      operator
    };

    if (explicitTable) {
      predicate.table = explicitTable;
    }
    if (options.table) {
      predicate.table = options.table;
    }

    const serializer = typeof options.serializeValue === 'function' ? options.serializeValue : null;
    const storedValue = serializer ? serializer(value) : value;

    if ((operator === 'IS' || operator === 'IS NOT') && storedValue === null) {
      predicate.value = null;
      return predicate;
    }

    if (storedValue !== undefined) {
      predicate.value = storedValue;
      if (typeof options.valueTransform === 'function') {
        predicate.valueTransform = options.valueTransform;
      } else if (options.cast) {
        predicate.valueTransform = placeholder => `${placeholder}::${options.cast}`;
      } else {
        predicate.valueTransform = placeholder => placeholder;
      }
    }

    return predicate;
  }

  _splitFieldReference(field) {
    if (typeof field !== 'string') {
      return { table: null, column: field };
    }

    const dotIndex = field.indexOf('.');
    if (dotIndex === -1) {
      return { table: null, column: field };
    }

    const table = field.slice(0, dotIndex);
    const column = field.slice(dotIndex + 1);
    return { table, column };
  }

  _buildWhereClause({ qualifyColumns = false } = {}) {
    if (!Array.isArray(this._where) || this._where.length === 0) {
      this._params = [];
      this._paramIndex = 1;
      return { sql: '', params: [] };
    }

    const params = [];
    let nextIndex = 1;

    const context = {
      qualifyColumns,
      defaultTable: this.tableName,
      getNextPlaceholder: () => `$${nextIndex++}`,
      params
    };

    const fragments = [];
    for (const predicate of this._where) {
      const fragment = this._renderPredicate(predicate, context);
      if (fragment) {
        fragments.push(fragment);
      }
    }

    this._params = params;
    this._paramIndex = nextIndex;

    return {
      sql: fragments.join(' AND '),
      params
    };
  }

  _renderPredicate(predicate, context) {
    if (!predicate) {
      return '';
    }

    if (predicate.type === 'group') {
      const conjunction = predicate.conjunction || 'AND';
      const inner = [];
      for (const child of predicate.predicates || []) {
        const rendered = this._renderPredicate(child, context);
        if (rendered) {
          inner.push(rendered);
        }
      }
      if (inner.length === 0) {
        return '';
      }
      return `(${inner.join(` ${conjunction} `)})`;
    }

    if (predicate.type === 'raw' && predicate.sql) {
      // Raw predicates may contribute their own parameters
      if (Array.isArray(predicate.values)) {
        for (const value of predicate.values) {
          context.params.push(value);
        }
      }
      return predicate.sql;
    }

    return this._renderBasicPredicate(predicate, context);
  }

  _renderBasicPredicate(predicate, context) {
    const columnSql = this._qualifyColumn(predicate, context);
    const { operator } = predicate;

    if ((operator === 'IS' || operator === 'IS NOT') && predicate.value === null) {
      return `${columnSql} ${operator} NULL`;
    }

    if (predicate.value === undefined) {
      return `${columnSql} ${operator}`;
    }

    const placeholder = context.getNextPlaceholder();
    context.params.push(predicate.value);

    const transform = typeof predicate.valueTransform === 'function'
      ? predicate.valueTransform
      : (value => value);
    const valueSql = transform(placeholder);

    return `${columnSql} ${operator} ${valueSql}`;
  }

  _qualifyColumn(predicate, context) {
    const { column } = predicate;
    if (!column || typeof column !== 'string') {
      return column;
    }

    if (predicate.table) {
      return `${predicate.table}.${column}`;
    }

    if (!context.qualifyColumns) {
      return column;
    }

    if (column.includes('.') || column.includes('(')) {
      return column;
    }

    return `${context.defaultTable}.${column}`;
  }

  _isRevisionFilterPredicate(predicate) {
    if (!predicate) {
      return false;
    }

    if (predicate.type === 'basic') {
      return predicate.column === '_old_rev_of' || predicate.column === '_rev_deleted';
    }

    return false;
  }

  /**
   * Build SELECT query
   * @returns {{ sql: string, params: Array }} SQL query and parameters
   * @private
   */
  _buildSelectQuery() {
    let selectClause = this._select.join(', ');
    if (this._joins.length > 0 && this._select.includes('*')) {
      selectClause = `${this.tableName}.*`;
    }

    let query = `SELECT ${selectClause} FROM ${this.tableName}`;

    if (this._joins.length > 0) {
      query += ' ' + this._joins.join(' ');
    }

    const where = this._buildWhereClause({ qualifyColumns: true });
    if (where.sql) {
      query += ' WHERE ' + where.sql;
    }

    if (this._orderBy.length > 0) {
      const qualifiedOrderBy = this._orderBy.map(orderClause => {
        if (orderClause.includes('.') || orderClause.includes('(')) {
          return orderClause;
        }
        return orderClause.replace(/^(\w+)/, `${this.tableName}.$1`);
      });
      query += ' ORDER BY ' + qualifiedOrderBy.join(', ');
    }

    if (this._limit !== null) {
      query += ` LIMIT ${this._limit}`;
    }

    if (this._offset !== null) {
      query += ` OFFSET ${this._offset}`;
    }

    return { sql: query, params: where.params };
  }

  /**
   * Build COUNT query
   * @returns {{ sql: string, params: Array }} SQL query and parameters
   * @private
   */
  _buildCountQuery() {
    let query = `SELECT COUNT(*) as count FROM ${this.tableName}`;

    const where = this._buildWhereClause();
    if (where.sql) {
      query += ' WHERE ' + where.sql;
    }

    return { sql: query, params: where.params };
  }

  /**
   * Build DELETE query
   * @returns {{ sql: string, params: Array }} SQL query and parameters
   * @private
   */
  _buildDeleteQuery() {
    let query = `DELETE FROM ${this.tableName}`;

    const where = this._buildWhereClause();
    if (where.sql) {
      query += ' WHERE ' + where.sql;
    }

    return { sql: query, params: where.params };
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
