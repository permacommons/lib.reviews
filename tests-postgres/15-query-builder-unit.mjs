import test from 'ava';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/**
 * Unit tests for QueryBuilder functionality
 * 
 * Tests the query builder methods without requiring database connection
 */

test('QueryBuilder can be instantiated', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  
  t.truthy(qb);
  t.is(qb.tableName, 'test_table');
});

test('QueryBuilder supports filter method', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filter({ id: 'test-id' });
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
});

test('QueryBuilder supports orderBy method', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.orderBy('created_on', 'DESC');
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._orderBy.length > 0);
  t.is(qb._orderBy[0], 'created_on DESC');
});

test('QueryBuilder supports limit method', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.limit(10);
  
  t.is(result, qb); // Should return self for chaining
  t.is(qb._limit, 10);
});

test('QueryBuilder supports offset method', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.offset(5);
  
  t.is(result, qb); // Should return self for chaining
  t.is(qb._offset, 5);
});

test('QueryBuilder supports revision filtering', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filterNotStaleOrDeleted();
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  // Should have conditions for _old_rev_of IS NULL and _rev_deleted = false
  t.true(qb._where.some(condition => condition.includes('_old_rev_of IS NULL')));
  t.true(qb._where.some(condition => condition.includes('_rev_deleted')));
});

test('QueryBuilder supports revision tag filtering', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filterByRevisionTags(['test-tag']);
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  t.true(qb._params.length > 0);
  t.deepEqual(qb._params[0], ['test-tag']);
});

test('QueryBuilder supports between date ranges', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.between(startDate, endDate);
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length >= 2); // Should have start and end conditions
  t.true(qb._params.includes(startDate));
  t.true(qb._params.includes(endDate));
});

test('QueryBuilder supports array contains operations', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.contains('urls', 'https://example.com');
  
  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  t.true(qb._params.includes('https://example.com'));
  t.true(qb._where.some(condition => condition.includes('@>')));
});

test('QueryBuilder supports simple joins', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'reviews' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.getJoin({ thing: true });
  
  t.is(result, qb); // Should return self for chaining
  t.truthy(qb._joinSpecs);
  t.is(qb._joinSpecs.length, 1);
  t.deepEqual(qb._joinSpecs[0], { thing: true });
});

test('QueryBuilder supports complex joins with _apply', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'reviews' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.getJoin({
    creator: {
      _apply: seq => seq.without('password')
    }
  });
  
  t.is(result, qb); // Should return self for chaining
  t.truthy(qb._joinSpecs);
  t.is(qb._joinSpecs.length, 1);
  t.truthy(qb._joinSpecs[0].creator._apply);
});

test('QueryBuilder builds SELECT queries correctly', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });
  qb.orderBy('created_on', 'DESC');
  qb.limit(10);
  qb.offset(5);
  
  const query = qb._buildSelectQuery();
  
  t.true(query.includes('SELECT'));
  t.true(query.includes('FROM test_table'));
  t.true(query.includes('WHERE'));
  t.true(query.includes('ORDER BY test_table.created_on DESC'));
  t.true(query.includes('LIMIT 10'));
  t.true(query.includes('OFFSET 5'));
});

test('QueryBuilder builds COUNT queries correctly', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });
  
  const query = qb._buildCountQuery();
  
  t.true(query.includes('SELECT COUNT(*)'));
  t.true(query.includes('FROM test_table'));
  t.true(query.includes('WHERE'));
});

test('QueryBuilder builds DELETE queries correctly', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });
  
  const query = qb._buildDeleteQuery();
  
  t.true(query.includes('DELETE FROM test_table'));
  t.true(query.includes('WHERE'));
});

test('QueryBuilder handles join information lookup', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const relationMap = new Map([
    ['thing', {
      targetTable: 'things',
      sourceKey: 'thing_id',
      hasRevisions: true
    }],
    ['creator', {
      targetTable: 'users',
      sourceKey: 'created_by',
      hasRevisions: false
    }]
  ]);

  const mockModel = {
    tableName: 'reviews',
    getRelation: name => relationMap.get(name) || null
  };
  const mockDAL = { tablePrefix: '' };

  const qb = new QueryBuilder(mockModel, mockDAL);

  // Test known join mappings coming from model metadata
  const thingJoin = qb._getJoinInfo('thing');
  t.truthy(thingJoin);
  t.is(thingJoin.table, 'things');
  t.true(thingJoin.hasRevisions);
  t.is(thingJoin.condition, 'reviews.thing_id = things.id');
  t.is(thingJoin.sourceColumn, 'thing_id');
  t.is(thingJoin.targetColumn, 'id');
  t.is(thingJoin.cardinality, 'one');
  t.is(thingJoin.type, 'direct');

  const creatorJoin = qb._getJoinInfo('creator');
  t.truthy(creatorJoin);
  t.is(creatorJoin.table, 'users');
  t.false(creatorJoin.hasRevisions);
  t.is(creatorJoin.condition, 'reviews.created_by = users.id');
  t.is(creatorJoin.sourceColumn, 'created_by');
  t.is(creatorJoin.targetColumn, 'id');
  t.is(creatorJoin.cardinality, 'one');

  // Test unknown join
  const unknownJoin = qb._getJoinInfo('unknown');
  t.is(unknownJoin, null);
});

test('QueryBuilder handles table name prefixing', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: 'test_prefix_' };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  
  const tableName = qb._getTableName('users');
  t.is(tableName, 'test_prefix_users');
  
  // Test without prefix
  const mockDALNoPrefix = { tablePrefix: '' };
  const qb2 = new QueryBuilder(mockModel, mockDALNoPrefix);
  const tableName2 = qb2._getTableName('users');
  t.is(tableName2, 'users');
});

test('QueryBuilder method chaining works correctly', t => {
  const QueryBuilder = require('../dal/lib/query-builder');
  const mockModel = { tableName: 'test_table' };
  const mockDAL = { tablePrefix: '' };

  const qb = new QueryBuilder(mockModel, mockDAL);

  // Test method chaining
  const result = qb
    .filter({ status: 'active' })
    .filterNotStaleOrDeleted()
    .orderBy('created_on', 'DESC')
    .limit(10)
    .offset(5)
    .getJoin({ creator: true });

  t.is(result, qb); // Should return the same instance
  t.true(qb._where.length > 0);
  t.true(qb._orderBy.length > 0);
  t.is(qb._limit, 10);
  t.is(qb._offset, 5);
  t.truthy(qb._joinSpecs);
});

test('Model constructor maps camelCase fields to snake_case columns', async t => {
  const { initializeModel } = require('../dal/lib/model-initializer');
  const type = require('../dal').type;
  const BaseModel = require('../dal/lib/model');

  const capturedQueries = [];
  const mockDAL = {
    tablePrefix: '',
    async query(sql, params) {
      capturedQueries.push({ sql, params });
      return { rows: [{ id: 'generated-id', camel_case_field: params[0] }] };
    },
    createModel(name, schema, options = {}) {
      return BaseModel.createModel(name, schema, options, this);
    },
    getModel(name) {
      throw new Error(`Model '${name}' not found`);
    }
  };

  const { model: TestModel } = initializeModel({
    dal: mockDAL,
    baseTable: 'tmp_models',
    schema: {
      id: type.string(),
      camelCaseField: type.string().default('fallback')
    },
    camelToSnake: {
      camelCaseField: 'camel_case_field'
    }
  });

  const instance = new TestModel({ camelCaseField: 'value' });

  t.is(instance._data.camel_case_field, 'value');
  t.false(Object.prototype.hasOwnProperty.call(instance._data, 'camelCaseField'));

  await instance.save();

  t.true(capturedQueries[0].sql.includes('camel_case_field'));
  t.deepEqual(capturedQueries[0].params, ['value']);

  const defaultedInstance = new TestModel();
  t.is(defaultedInstance._data.camel_case_field, 'fallback');
});
