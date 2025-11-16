import debug from '../../util/debug.ts';
import { convertPostgreSQLError } from './errors.ts';
import type Model from './model.ts';
import type { ModelRuntime } from './model.ts';
import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance,
} from './model-types.ts';
import { NumberType } from './type.ts';

type PredicateValue = unknown;

type IncrementResult<TRow extends JsonObject> = {
  rowCount: number;
  rows: TRow[];
};

/**
 * Convert a database row with snake_case keys to the model's camelCase schema keys.
 *
 * @param row Database row to normalize
 * @param fieldMappings Camel-to-snake mapping registered on the model
 * @returns Row keyed by camelCase field names
 */
function remapRowToCamelCase<TRow extends JsonObject>(
  row: JsonObject,
  fieldMappings?: Map<string, string>
): TRow {
  if (!(fieldMappings instanceof Map) || fieldMappings.size === 0) {
    return row as TRow;
  }

  const reverseMapping = new Map<string, string>();
  for (const [camel, snake] of fieldMappings.entries()) {
    reverseMapping.set(snake, camel);
  }

  const remapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = reverseMapping.get(key) ?? key;
    remapped[camelKey] = value;
  }

  return remapped as unknown as TRow;
}

interface BasicPredicate extends JsonObject {
  type: 'basic';
  table?: string | null;
  column: string | unknown;
  operator: string;
  value?: PredicateValue;
  valueTransform?: (placeholder: string) => string;
}

interface GroupPredicate extends JsonObject {
  type: 'group';
  conjunction: 'AND' | 'OR';
  predicates: Predicate[];
}

interface RawPredicate extends JsonObject {
  type: 'raw';
  sql: string;
  values?: unknown[];
}

type Predicate = BasicPredicate | GroupPredicate | RawPredicate;

interface RelationJoinInfo extends JsonObject {
  type: 'through' | 'direct';
  table: string;
  baseTable: string;
  hasRevisions: boolean;
  condition: string;
  sourceColumn: string;
  targetColumn: string;
  cardinality: 'one' | 'many';
  isArray: boolean;
  targetModelKey?: string;
  joinTable?: string;
  joinTableOn?: string;
  joinTableSourceColumn?: string;
  joinTableTargetColumn?: string;
}

interface ComplexJoinSpec extends JsonObject {
  joinInfo: RelationJoinInfo;
  _apply?: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}

interface JoinApplyFilter extends JsonObject {
  field: string;
  value?: unknown;
  operator?: string;
}

interface JoinApplyOrder extends JsonObject {
  field: string;
  direction: 'ASC' | 'DESC';
}

interface JoinApplyAnalysis extends JsonObject {
  removeFields: string[];
  filters: JoinApplyFilter[];
  order?: JoinApplyOrder;
  limit?: number;
}

interface BetweenOptions extends JsonObject {
  leftBound?: 'open' | 'closed';
  rightBound?: 'open' | 'closed';
}

interface PredicateOptions extends JsonObject {
  table?: string | null;
  serializeValue?: (value: unknown) => unknown;
  cast?: string;
  valueTransform?: (placeholder: string) => string;
}

type QueryModel = ModelRuntime<JsonObject, JsonObject> &
  ModelConstructor<JsonObject, JsonObject, ModelInstance>;
type QueryInstance = Model<JsonObject, JsonObject> & ModelInstance;

/**
 * Query Builder for PostgreSQL DAL
 *
 * Provides a fluent interface for building and executing database queries.
 */

/**
 * Fluent query builder for the PostgreSQL DAL.
 *
 * Produces parameterized SQL for SELECT/COUNT/DELETE with support for
 * predicates, ordering, pagination, and both simple and complex joins.
 * Instances are model-aware (leveraging table/column metadata) and implement
 * Promise-like behavior so they can be awaited directly.
 */
class QueryBuilder implements PromiseLike<QueryInstance[]> {
  modelClass: QueryModel;
  dal: DataAccessLayer;
  tableName: string;
  _select: string[];
  _where: Predicate[];
  _joins: string[];
  _orderBy: string[];
  _limit: number | null;
  _offset: number | null;
  _params: unknown[];
  _paramIndex: number;
  _includeSensitive: string[];
  _joinSpecs?: Array<Record<string, unknown>>;
  _simpleJoins?: Record<string, RelationJoinInfo>;
  _complexJoins?: Record<string, ComplexJoinSpec>;

  constructor(modelClass: QueryModel, dal: DataAccessLayer) {
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
    this._includeSensitive = [];
  }

  /**
   * Include sensitive fields in query results
   * @param fields - Array of sensitive field names to include
   * @returns {QueryBuilder} This instance for chaining
   */
  includeSensitive(fields: string | string[]): this {
    this._includeSensitive = Array.isArray(fields) ? fields : [fields];
    return this;
  }

  /**
   * Resolve a logical field reference to a database column.
   *
   * @private
   * @param fieldName - Field identifier from legacy code
   * @returns {string} Database column name
   */
  _resolveFieldName(fieldName: string | symbol): string | symbol {
    if (typeof fieldName !== 'string') {
      return fieldName;
    }

    if (
      this.modelClass &&
      typeof (this.modelClass as QueryModel & { _getDbFieldName?: (field: string) => string })
        ._getDbFieldName === 'function'
    ) {
      return (
        this.modelClass as QueryModel & { _getDbFieldName?: (field: string) => string }
      )._getDbFieldName(fieldName);
    }

    return fieldName;
  }

  _assertResolvedField(field: string | symbol): string | symbol {
    if (typeof field !== 'string') {
      return field;
    }

    if (field.includes('.') || field.includes('(')) {
      return field;
    }

    const resolved = this._resolveFieldName(field);
    if (resolved !== field) {
      throw new Error(
        `QueryBuilder expected a resolved database column name but received "${field}".`
      );
    }

    return field;
  }

  /**
   * Filter by revision user
   * @param userId - User ID who created the revision
   * @returns {QueryBuilder} This instance for chaining
   */
  filterByRevisionUser(userId) {
    this._addWhereCondition('_rev_user', '=', userId);
    return this;
  }

  /**
   * Filter by revision tags
   * @param tags - Tag or array of tags to filter by
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
   * @param startDate - Start date (inclusive)
   * @param endDate - End date (inclusive)
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
   * Filter by date range
   * @param startDate - Start date
   * @param endDate - End date
   * @param options - Options (leftBound, rightBound)
   * @returns {QueryBuilder} This instance for chaining
   */
  between(
    startDate: Date | string | number,
    endDate: Date | string | number,
    options: BetweenOptions = {}
  ): this {
    const leftOp = options.leftBound === 'open' ? '>' : '>=';
    const rightOp = options.rightBound === 'open' ? '<' : '<=';

    this._addWhereCondition('created_on', leftOp, startDate);
    this._addWhereCondition('created_on', rightOp, endDate);

    return this;
  }

  /**
   * Filter by array contains (for PostgreSQL arrays)
   * @param field - Field name
   * @param value - Value to check for
   * @returns {QueryBuilder} This instance for chaining
   */
  contains(field: string, value: unknown): this {
    const values = Array.isArray(value) ? value : [value];
    this._addWhereCondition(field, '@>', values, {
      cast: 'text[]',
    });
    return this;
  }

  /**
   * Filter by JSONB field contains
   * @param field - JSONB field name
   * @param value - Value to check for
   * @returns {QueryBuilder} This instance for chaining
   */
  containsJsonb(field: string, value: JsonObject): this {
    this._addWhereCondition(field, '@>', value, {
      cast: 'jsonb',
      serializeValue: JSON.stringify,
    });
    return this;
  }

  /**
   * Filter by field existence in JSONB
   * @param field - JSONB field name
   * @param key - Key to check for existence
   * @returns {QueryBuilder} This instance for chaining
   */
  hasFields(field: string, key: string): this {
    this._addWhereCondition(field, '?', key);
    return this;
  }

  /**
   * Filter by membership in a list of values using PostgreSQL ANY
   * @param field - Field name
   * @param values - Values to match
   * @param [options] - Additional options
   * @param [options.cast] - Optional cast to apply to the parameter (e.g., 'uuid[]')
   * @returns {QueryBuilder} This instance for chaining
   */
  whereIn(field: string, values: unknown[], { cast }: { cast?: string } = {}): this {
    if (!Array.isArray(values) || values.length === 0) {
      return this;
    }

    const valueTransform = placeholder => `(${placeholder}${cast ? `::${cast}` : ''})`;
    this._addWhereCondition(field, '= ANY', values, { valueTransform });
    return this;
  }

  /**
   * Get all revisions of a specific document (including old and deleted)
   * @param documentId - The document ID to get revisions for
   * @returns {QueryBuilder} This instance for chaining
   */
  getAllRevisions(documentId) {
    // Clear any existing revision filters
    this._where = this._where.filter(predicate => !this._isRevisionFilterPredicate(predicate));

    // Add condition to get all revisions of the document
    const idPredicate = this._createPredicate('id', '=', documentId);
    const oldRevPredicate = this._createPredicate('_old_rev_of', '=', documentId);
    const groupPredicate: GroupPredicate = {
      type: 'group',
      conjunction: 'OR',
      predicates: [idPredicate, oldRevPredicate],
    };
    this._where.push(groupPredicate);

    return this;
  }

  /**
   * Add ORDER BY clause
   * @param field - Field to order by
   * @param direction - Sort direction (ASC/DESC)
   * @returns {QueryBuilder} This instance for chaining
   */
  orderBy(field, direction = 'ASC') {
    let expression = field;
    if (typeof field === 'string' && !field.includes('(')) {
      const { table, column } = this._splitFieldReference(field);
      const resolvedColumn = this._resolvePredicateColumn(table || null, column);
      if (table) {
        expression = `${table}.${resolvedColumn}`;
      } else {
        expression = resolvedColumn;
      }
    }
    this._orderBy.push(`${expression} ${direction.toUpperCase()}`);
    return this;
  }

  /**
   * Add LIMIT clause
   * @param count - Limit count
   * @returns {QueryBuilder} This instance for chaining
   */
  limit(count) {
    this._limit = count;
    return this;
  }

  /**
   * Add OFFSET clause
   * @param count - Offset count
   * @returns {QueryBuilder} This instance for chaining
   */
  offset(count) {
    this._offset = count;
    return this;
  }

  /**
   * Add JOIN clauses with support for complex joins
   * @param joinSpec - Join specification
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
   * @param relationName - Name of the relation
   * @param relationSpec - Join specification
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
   * @param relationName - Name of the relation
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
   * @param relationName - Name of the relation
   * @param relationSpec - Join specification with _apply, filters, etc.
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
      ...(relationSpec as JsonObject),
      joinInfo,
    } as ComplexJoinSpec;
  }

  /**
   * Get join information for a relation name
   * @param relationName - Name of the relation
   * @returns {Object|null} Join information
   * @private
   */
  _getJoinInfo(relationName: string): RelationJoinInfo | null {
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
      debug.db(
        `Warning: Relation '${relationName}' on '${this.tableName}' is missing a target table definition`
      );
      return null;
    }

    const hasRevisions = Boolean(relationConfig.hasRevisions);
    const sourceColumn = relationConfig.sourceColumn || relationConfig.sourceKey || 'id';
    const targetColumn = relationConfig.targetColumn || relationConfig.targetKey || 'id';
    const cardinality = relationConfig.cardinality || (relationConfig.isArray ? 'many' : 'one');
    const targetModelKey =
      relationConfig.targetModelKey || relationConfig.targetModel || baseTargetTable;

    if (relationConfig.through && typeof relationConfig.through === 'object') {
      const joinTableName = this._resolveTableReference(
        relationConfig.through.table || relationConfig.joinTable
      );
      if (!joinTableName) {
        debug.db(
          `Warning: Relation '${relationName}' on '${this.tableName}' is missing a join table definition`
        );
        return null;
      }

      const throughSourceKey =
        relationConfig.through.sourceColumn ||
        relationConfig.through.sourceForeignKey ||
        relationConfig.through.sourceKey;
      const throughTargetKey =
        relationConfig.through.targetColumn ||
        relationConfig.through.targetForeignKey ||
        relationConfig.through.targetKey;

      if (!throughSourceKey || !throughTargetKey) {
        debug.db(
          `Warning: Relation '${relationName}' on '${this.tableName}' is missing join column metadata`
        );
        return null;
      }

      const joinTableOn =
        relationConfig.through.sourceCondition ||
        `${this.tableName}.${sourceColumn} = ${joinTableName}.${throughSourceKey}`;
      const targetCondition =
        relationConfig.condition ||
        relationConfig.through.targetCondition ||
        `${joinTableName}.${throughTargetKey} = ${targetTableName}.${targetColumn}`;

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
        targetModelKey,
      } as RelationJoinInfo;
    }

    const directCondition =
      relationConfig.condition ||
      `${this.tableName}.${sourceColumn} = ${targetTableName}.${targetColumn}`;

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
      targetModelKey,
    } as RelationJoinInfo;
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
   * Get table name with optional schema namespace
   * @param baseName - Base table name
   * @returns {string} Full table name
   * @private
   */
  _getTableName(baseName) {
    const namespace = this.dal.schemaNamespace || '';
    return namespace + baseName;
  }

  /**
   * Execute query and return all results
   * @returns {Promise<Array>} Query results
   */
  async run(): Promise<QueryInstance[]> {
    try {
      // Handle complex joins that require separate queries
      if (this._complexJoins && Object.keys(this._complexJoins).length > 0) {
        return await this._runWithComplexJoins();
      }

      const { sql, params } = this._buildSelectQuery();
      const result = await this.dal.query(sql, params);

      // Process results with simple joins
      return await this._processResults(result.rows as Record<string, unknown>[]);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Allow QueryBuilder to behave like a Promise (basic thenable)
   * @param onFulfilled - Success handler
   * @param onRejected - Error handler
   * @returns {Promise} Promise resolving to query results
   */
  then<TResult1 = QueryInstance[], TResult2 = never>(
    onFulfilled?: ((value: QueryInstance[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected);
  }

  /**
   * Catch handler for Promise-like usage
   * @param onRejected - Error handler
   * @returns {Promise} Promise resolving to query results
   */
  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<QueryInstance[] | TResult> {
    return this.run().catch(onRejected);
  }

  /**
   * Finally handler for Promise-like usage
   * @param onFinally - Finally handler
   * @returns {Promise} Promise resolving to query results
   */
  finally(onFinally?: (() => void) | null): Promise<QueryInstance[]> {
    return this.run().finally(onFinally ?? undefined);
  }

  /**
   * Execute query with complex joins that require separate queries
   * @returns {Promise<Array>} Query results with joined data
   * @private
   */
  async _runWithComplexJoins(): Promise<QueryInstance[]> {
    // First get the main results
    const mainQuery = this._buildSelectQuery();
    const mainResult = await this.dal.query(mainQuery.sql, mainQuery.params);
    const mainRows = await this._processResults(mainResult.rows as Record<string, unknown>[]);

    // Process each complex join
    for (const [relationName, joinSpec] of Object.entries(this._complexJoins)) {
      await this._processComplexJoin(mainRows, relationName, joinSpec);
    }

    return mainRows;
  }

  /**
   * Process a complex join by executing separate queries
   * @param mainRows - Main query results
   * @param relationName - Name of the relation
   * @param joinSpec - Join specification
   * @private
   */
  async _processComplexJoin(
    mainRows: Array<Record<string, unknown>>,
    relationName: string,
    joinSpec: ComplexJoinSpec
  ): Promise<void> {
    if (!Array.isArray(mainRows) || mainRows.length === 0) {
      return;
    }

    const { joinInfo } = joinSpec;
    if (!joinInfo) {
      debug.db(
        `Warning: Missing join metadata for relation '${relationName}' on '${this.tableName}'`
      );
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
    let relatedRows = (relatedResult.rows || []) as Array<Record<string, unknown>>;

    if (analysis?.removeFields?.length) {
      relatedRows = this._applyJoinFieldOmissions(relatedRows, analysis.removeFields);
    }

    const groupedRows = this._groupRelatedRows(relatedRows, joinSourceAlias);
    this._assignJoinResults(mainRows, relationName, joinInfo, groupedRows);
  }

  _extractJoinSourceValues(
    mainRows: Array<Record<string, unknown>>,
    sourceColumn: string | undefined
  ) {
    if (!sourceColumn) {
      return [];
    }

    const values: unknown[] = [];
    const seen = new Set<string>();
    for (const row of mainRows) {
      const value = this._getRowValue(row, sourceColumn);
      if (value === undefined || value === null) {
        continue;
      }

      const key = value instanceof Date ? String(value.getTime()) : `${value}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      values.push(value);
    }

    return values;
  }

  _buildComplexJoinQuery(relationName, joinInfo, sourceValues, analysis = null) {
    const params: unknown[] = [sourceValues];
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
      whereClauses.push(
        `(${targetAlias}._rev_deleted IS NULL OR ${targetAlias}._rev_deleted = false)`
      );
    }

    if (analysis?.filters?.length) {
      for (const filter of analysis.filters) {
        const column = this._normalizeColumnName(filter.field);
        if (column === '_rev_deleted' && filter.value === false) {
          whereClauses.push(
            `(${targetAlias}._rev_deleted IS NULL OR ${targetAlias}._rev_deleted = false)`
          );
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

  _groupRelatedRows(rows: Array<Record<string, unknown>>, joinSourceAlias = '_join_source_id') {
    const grouped = new Map<unknown, Record<string, unknown>[]>();
    if (!Array.isArray(rows)) {
      return grouped;
    }

    for (const row of rows) {
      if (
        !row ||
        typeof row !== 'object' ||
        !Object.prototype.hasOwnProperty.call(row, joinSourceAlias)
      ) {
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

  _assignJoinResults(
    mainRows: Array<Record<string, unknown>>,
    relationName: string,
    joinInfo: RelationJoinInfo,
    groupedRows: Map<unknown, Record<string, unknown>[]>
  ) {
    const RelatedModel = this._getRelatedModel(relationName, joinInfo);
    const expectsArray = joinInfo.isArray !== false && joinInfo.cardinality !== 'one';
    const sourceColumn = joinInfo.sourceColumn || 'id';

    for (const mainRow of mainRows) {
      const joinKey = this._getRowValue(mainRow, sourceColumn);
      const related =
        joinKey === undefined || joinKey === null ? [] : groupedRows.get(joinKey) || [];

      if (expectsArray) {
        mainRow[relationName] = related.map(row => this._instantiateRelated(RelatedModel, row));
      } else {
        const match = related[0] || null;
        mainRow[relationName] = match ? this._instantiateRelated(RelatedModel, match) : null;
      }
    }
  }

  private _instantiateRelated(
    RelatedModel: (ModelConstructor<JsonObject, JsonObject, ModelInstance> & typeof Model) | null,
    data: Record<string, unknown>
  ): QueryInstance | Record<string, unknown> {
    if (!RelatedModel) {
      return data;
    }

    const runtime = RelatedModel as QueryModel & {
      _createInstance?: (row: JsonObject) => QueryInstance;
    };
    if (typeof runtime._createInstance === 'function') {
      return runtime._createInstance(data);
    }

    return new RelatedModel(data) as QueryInstance;
  }

  _getRowValue(row: Record<string, unknown> | ModelInstance, column: string | undefined) {
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

  _analyzeJoinApply(applyFn: ((qb: unknown) => unknown) | undefined): JoinApplyAnalysis | null {
    if (typeof applyFn !== 'function') {
      return null;
    }

    const source = applyFn.toString();
    const analysis: JoinApplyAnalysis = {
      removeFields: [],
      filters: [],
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

    const filterMatch = source.match(/filter(?:Where)?\(\{([^}]*)\}\)/);
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

    const withUnderscores = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_');
    return withUnderscores.toLowerCase();
  }

  /**
   * Get the model class for a relation
   * @param relationName - Name of the relation
   * @returns {Function|null} Model class
   * @private
   */
  _getRelatedModel(
    relationName: string,
    joinInfo: RelationJoinInfo | null = null
  ): (ModelConstructor<JsonObject, JsonObject, ModelInstance> & typeof Model) | null {
    const registry = this._getModelRegistry();
    if (!registry || typeof registry.get !== 'function') {
      return null;
    }

    const metadata: Partial<RelationJoinInfo> =
      joinInfo ??
      this._simpleJoins?.[relationName] ??
      this._complexJoins?.[relationName]?.joinInfo ??
      {};

    const identifiers = [metadata.targetModelKey, metadata.baseTable, metadata.table, relationName];

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

    let registry: unknown = null;
    if (typeof this.dal.getModelRegistry === 'function') {
      registry = this.dal.getModelRegistry();
    } else {
      registry = (this.dal as DataAccessLayer & { modelRegistry?: unknown }).modelRegistry ?? null;
    }

    if (!registry || typeof (registry as { get?: unknown }).get !== 'function') {
      return null;
    }

    return registry as { get(identifier: string): QueryModel | null };
  }

  /**
   * Process query results, handling simple joins
   * @param rows - Raw database rows
   * @returns {Promise<Array>} Processed model instances
   * @private
   */
  async _processResults(rows: Array<Record<string, unknown>>): Promise<QueryInstance[]> {
    const BaseModel = this.modelClass as QueryModel & typeof Model;

    if (!this._simpleJoins || Object.keys(this._simpleJoins).length === 0) {
      // No joins, just create model instances
      return rows.map(row => this._instantiateRelated(BaseModel, row)) as QueryInstance[];
    }

    // Process rows with joined data
    const processedRows = [];
    for (const row of rows) {
      const mainData: Record<string, unknown> = {};
      const joinedData: Record<string, Record<string, unknown>> = {};

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
      const instance = this._instantiateRelated(BaseModel, mainData) as QueryInstance;

      // Attach joined data
      for (const [relationName, data] of Object.entries(joinedData)) {
        // When a LEFT JOIN finds no matching row, all joined columns are NULL
        // Only create a model instance if at least one field has a non-null value
        const hasMatchingRow =
          data && typeof data === 'object' && Object.keys(data).some(key => data[key] !== null);

        if (hasMatchingRow) {
          // Create model instance for joined data
          const joinInfo = this._simpleJoins ? this._simpleJoins[relationName] : null;
          const RelatedModel = this._getRelatedModel(relationName, joinInfo);
          (instance as Record<string, unknown>)[relationName] = this._instantiateRelated(
            RelatedModel,
            data
          );
        } else {
          // No matching row found in join
          (instance as Record<string, unknown>)[relationName] = null;
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
  async first(): Promise<QueryInstance | null> {
    this.limit(1);
    const results = await this.run();
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Execute query and return count
   * @returns {Promise<number>} Result count
   */
  async count(): Promise<number> {
    try {
      const { sql, params } = this._buildCountQuery();
      const result = await this.dal.query(sql, params);

      const [row] = result.rows as Array<{ count?: string | number }>;
      return Number.parseInt(String(row?.count ?? '0'), 10);
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Calculate the average for a column.
   *
   * @param field - Column to aggregate.
   * @returns Numeric average or `null` when no rows satisfy the predicates.
   */
  async average(field: string): Promise<number | null> {
    return this._aggregateFunction('AVG', field);
  }

  /**
   * Compute an aggregate for the active query.
   *
   * @param func - SQL aggregate function identifier (e.g., `AVG`).
   * @param field - Resolved field/column name to aggregate.
   * @returns Numeric aggregate result or `null` when no rows match.
   */
  async _aggregateFunction(func: 'AVG' | 'SUM' | 'MIN' | 'MAX', field: string) {
    try {
      const column =
        typeof field === 'string' && (field.includes('.') || field.includes('('))
          ? field
          : `${this.tableName}.${field}`;
      const { sql, params } = this._buildAggregateQuery(func, column);
      const result = await this.dal.query(sql, params);
      const value = result.rows[0]?.value;
      if (value === null || value === undefined) {
        return null;
      }
      const numeric = typeof value === 'number' ? value : Number(value);
      return Number.isNaN(numeric) ? null : numeric;
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Delete records matching the query
   * @returns {Promise<Object>} Delete result
   */
  async delete(): Promise<number> {
    try {
      const { sql, params } = this._buildDeleteQuery();
      const result = await this.dal.query(sql, params);
      return typeof result.rowCount === 'number' ? result.rowCount : 0;
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Delete a record by ID
   * @param id - Record ID
   * @returns {Promise<Object>} Delete result
   */
  async deleteById(id: string): Promise<number> {
    try {
      const query = `DELETE FROM ${this.tableName} WHERE id = $1`;
      const result = await this.dal.query(query, [id]);
      return typeof result.rowCount === 'number' ? result.rowCount : 0;
    } catch (error) {
      throw convertPostgreSQLError(error);
    }
  }

  /**
   * Add a WHERE condition
   * @param field - Field name
   * @param operator - Comparison operator
   * @param value - Comparison value
   * @param [options] - Predicate options
   * @returns {Object} Predicate descriptor
   * @private
   */
  _addWhereCondition(
    field: string | number | symbol,
    operator: string,
    value: unknown,
    options: PredicateOptions = {}
  ): Predicate {
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
   * Add a predicate against a column on a joined relation. This will ensure the
   * relation is joined and apply a WHERE clause to the related table using
   * camelCase field names.
   *
   * @param relationName - Relation key from the manifest
   * @param field - CamelCase field on the related model
   * @param operator - Comparison operator (defaults to '=')
   * @param value - Comparison value
   */
  whereRelated(relationName: string, field: string, operator: string, value: unknown): this {
    const joinInfo = this._getJoinInfo(relationName);
    if (!joinInfo) {
      debug.db(`Warning: Unknown relation '${relationName}' for table '${this.tableName}'`);
      return this;
    }

    this._addSimpleJoin(relationName);
    const column = `${joinInfo.table}.${this._normalizeColumnName(field)}`;
    this._addWhereCondition(column, operator, value);
    return this;
  }

  /**
   * Create a predicate descriptor without mutating the WHERE clause
   * @param field - Field reference (optionally qualified)
   * @param operator - Comparison operator
   * @param value - Comparison value
   * @param options - Predicate options
   * @param [options.serializeValue] - Serializer for stored value
   * @param [options.cast] - Cast to append to placeholder (e.g., 'jsonb')
   * @param [options.valueTransform] - Custom placeholder transformer
   * @returns {Object} Predicate descriptor
   * @private
   */
  _createPredicate(
    field: string | number | symbol,
    operator: string,
    value: unknown,
    options: PredicateOptions = {}
  ): BasicPredicate {
    const { table: explicitTable, column } = this._splitFieldReference(field);
    const tableReference = options.table || explicitTable || null;
    const resolvedColumn = this._resolvePredicateColumn(tableReference, column);

    const predicate: BasicPredicate = {
      type: 'basic',
      column: resolvedColumn,
      operator,
    };

    if (tableReference) {
      predicate.table = tableReference;
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

  _resolvePredicateColumn(tableReference, column) {
    if (typeof column !== 'string' || column === '*' || /[()\s]/.test(column)) {
      return column;
    }

    const normalizedTable = tableReference || null;
    const schemaNamespace =
      this.dal && typeof this.dal.schemaNamespace === 'string' ? this.dal.schemaNamespace : '';
    const unprefixedTableName =
      schemaNamespace && this.tableName.startsWith(schemaNamespace)
        ? this.tableName.slice(schemaNamespace.length)
        : this.tableName;
    const isBaseTable =
      normalizedTable === null ||
      normalizedTable === this.tableName ||
      normalizedTable === unprefixedTableName;
    if (isBaseTable) {
      return this._resolveFieldName(column);
    }

    return column;
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
      params,
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
      params,
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

    const transform =
      typeof predicate.valueTransform === 'function' ? predicate.valueTransform : value => value;
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

    // Replace SELECT * with explicit column list to exclude sensitive fields
    // (e.g., passwords). For models without sensitive fields, getColumnNames()
    // returns all columns, equivalent to SELECT *.
    if (this._select.includes('*')) {
      const columns = this.modelClass.getColumnNames(this._includeSensitive);
      const mainTableColumns = columns.map(col => `${this.tableName}.${col}`);

      if (this._joins.length > 0) {
        selectClause = mainTableColumns.join(', ');

        // Add columns from simple joins with prefixed aliases
        if (this._simpleJoins) {
          const joinSelects = [];
          for (const [relationName, joinInfo] of Object.entries(this._simpleJoins)) {
            if (joinInfo && joinInfo.table) {
              // Get the related model to get safe (non-sensitive) column names
              const RelatedModel = this._getRelatedModel(relationName, joinInfo);
              const safeColumns = RelatedModel.getSafeColumnNames();

              // Select each safe column with a prefixed alias (e.g., creator_id, creator_display_name)
              for (const col of safeColumns) {
                joinSelects.push(`${joinInfo.table}.${col} AS "${relationName}_${col}"`);
              }
            }
          }
          if (joinSelects.length > 0) {
            selectClause += ', ' + joinSelects.join(', ');
          }
        }
      } else {
        // No joins, just list the columns
        selectClause = mainTableColumns.join(', ');
      }
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

    if (this._joins.length > 0) {
      query += ` ${this._joins.join(' ')}`;
    }

    const where = this._buildWhereClause({ qualifyColumns: this._joins.length > 0 });
    if (where.sql) {
      query += ' WHERE ' + where.sql;
    }

    return { sql: query, params: where.params };
  }

  /**
   * Build an aggregate query (`AVG`, `COUNT`, etc.) for the current predicates.
   *
   * @param func - Aggregate function keyword.
   * @param column - Fully qualified column expression.
   * @returns SQL fragment plus bound params.
   */
  _buildAggregateQuery(func: string, column: string) {
    let query = `SELECT ${func}(${column}) as value FROM ${this.tableName}`;

    const where = this._buildWhereClause({ qualifyColumns: true });
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
   * Atomically increment a numeric column on rows matching the current predicate.
   *
   * @param field Model field (resolved to a DB column) to increment
   * @param amount Increment step (default: 1)
   * @param options Optional returning clause
   * @returns Rows matched/returned plus affected row count.
   */
  async increment<TRow extends JsonObject = JsonObject>(
    field: string,
    amount = 1,
    options: { returning?: string[] } = {}
  ): Promise<IncrementResult<TRow>> {
    if (!Number.isFinite(amount)) {
      throw new TypeError('QueryBuilder.increment amount must be a finite number.');
    }

    if (this._joins.length > 0) {
      throw new Error('QueryBuilder.increment does not support joined queries.');
    }

    const dbField = this._resolveFieldName(field);
    this._assertResolvedField(dbField);
    if (typeof dbField !== 'string') {
      throw new TypeError('QueryBuilder.increment requires a string column reference.');
    }

    const schema = (this.modelClass as unknown as { schema?: Record<string, unknown> }).schema;
    const fieldMappings = (this.modelClass as unknown as { _fieldMappings?: Map<string, string> })
      ._fieldMappings;

    let schemaFieldName: string | null = null;
    if (typeof field === 'string') {
      if (schema && field in schema) {
        schemaFieldName = field;
      }

      if (!schemaFieldName && fieldMappings instanceof Map) {
        for (const [schemaKey, dbKey] of fieldMappings.entries()) {
          if (dbKey === dbField || dbKey === field) {
            schemaFieldName = schemaKey;
            break;
          }
        }
      }
    }

    if (schema && schemaFieldName) {
      const columnDef = schema[schemaFieldName] as unknown;
      if (!(columnDef instanceof NumberType)) {
        throw new TypeError(
          `QueryBuilder.increment requires a numeric schema field; '${schemaFieldName}' is not numeric.`
        );
      }
    } else {
      throw new TypeError(
        `QueryBuilder.increment could not resolve schema metadata for field '${field}'.`
      );
    }

    const where = this._buildWhereClause();
    if (!where.sql) {
      throw new Error(
        'QueryBuilder.increment requires a WHERE clause to avoid full-table updates.'
      );
    }

    const params = [...where.params];
    const amountPlaceholder = `$${params.length + 1}`;
    params.push(amount);

    let query = `UPDATE ${this.tableName} SET ${dbField} = ${dbField} + ${amountPlaceholder} WHERE ${where.sql}`;

    const returningColumns = Array.isArray(options.returning) ? options.returning : [];
    if (returningColumns.length > 0) {
      const resolvedColumns = returningColumns.map(column => {
        const resolved = this._resolveFieldName(column);
        this._assertResolvedField(resolved);
        if (typeof resolved !== 'string') {
          throw new TypeError(
            'QueryBuilder.increment RETURNING requires string column references.'
          );
        }
        return resolved;
      });

      query += ` RETURNING ${resolvedColumns.join(', ')}`;
    }

    const result = await this.dal.query<TRow>(query, params);
    const rows =
      returningColumns.length > 0
        ? result.rows.map(row => remapRowToCamelCase<TRow>(row, fieldMappings))
        : [];

    return {
      rowCount: result.rowCount ?? result.rows.length,
      rows,
    };
  }

  /**
   * Get a random sample of records
   *
   * @param count - Number of records to sample
   * @returns {Promise<Array>} Array of sampled records
   */
  async sample(count = 1): Promise<QueryInstance[]> {
    // Add ORDER BY RANDOM() and LIMIT to get random sample
    this._orderBy = ['RANDOM()'];
    this._limit = count;

    const results = await this.run();
    return results;
  }
}

export { QueryBuilder };
export default QueryBuilder;
