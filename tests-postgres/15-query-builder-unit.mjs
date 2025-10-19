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
  const mockModel = { tableName: 'reviews' };
  const mockDAL = { tablePrefix: '', _getTableName: (name) => name };
  
  const qb = new QueryBuilder(mockModel, mockDAL);
  
  // Test known join mappings
  const thingJoin = qb._getJoinInfo('thing');
  t.truthy(thingJoin);
  t.is(thingJoin.table, 'things');
  t.true(thingJoin.hasRevisions);
  
  const creatorJoin = qb._getJoinInfo('creator');
  t.truthy(creatorJoin);
  t.is(creatorJoin.table, 'users');
  t.false(creatorJoin.hasRevisions);
  
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