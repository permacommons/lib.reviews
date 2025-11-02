// @ts-nocheck
// TODO: tighten QueryBuilder test typing once DAL helpers expose typed interfaces
import test from 'ava';

import * as dalModule from '../dal/index.ts';
import QueryBuilder from '../dal/lib/query-builder.ts';
import Model from '../dal/lib/model.ts';
import typesLib from '../dal/lib/type.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';

const createMockModel = (overrides: Record<string, unknown> = {}) => ({
  tableName: 'test_table',
  getColumnNames: () => ['id', 'name', 'created_on'],
  ...overrides
}) as any;

const createMockDAL = () => ({ schemaNamespace: '' }) as any;

/**
 * Unit tests for QueryBuilder functionality
 *
 * Tests the query builder methods without requiring database connection
 */

test('QueryBuilder can be instantiated', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);

  t.truthy(qb);
  t.is(qb.tableName, 'test_table');
});

test('QueryBuilder supports filter method', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filter({ id: 'test-id' });

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
});

test('QueryBuilder supports orderBy method', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.orderBy('created_on', 'DESC');

  t.is(result, qb); // Should return self for chaining
  t.true(qb._orderBy.length > 0);
  t.is(qb._orderBy[0], 'created_on DESC');
});

test('QueryBuilder supports limit method', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.limit(10);

  t.is(result, qb); // Should return self for chaining
  t.is(qb._limit, 10);
});

test('QueryBuilder supports offset method', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.offset(5);

  t.is(result, qb); // Should return self for chaining
  t.is(qb._offset, 5);
});

test('QueryBuilder supports revision filtering', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filterNotStaleOrDeleted();

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  t.truthy(oldRevisionPredicate);
  t.is(oldRevisionPredicate.operator, 'IS');

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  t.truthy(deletedPredicate);
  t.is(deletedPredicate.operator, '=');
  t.false(deletedPredicate.value);
});

test('QueryBuilder supports revision tag filtering', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.filterByRevisionTags(['test-tag']);

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  const tagPredicate = qb._where[0];
  t.is(tagPredicate.operator, '&&');
  t.deepEqual(tagPredicate.value, ['test-tag']);

  const { params } = qb._buildSelectQuery();
  t.deepEqual(params, [['test-tag']]);
});

test('QueryBuilder supports between date ranges', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.between(startDate, endDate);

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length >= 2); // Should have start and end conditions
  const { params: betweenParams } = qb._buildSelectQuery();
  t.true(betweenParams.includes(startDate));
  t.true(betweenParams.includes(endDate));
});

test('QueryBuilder supports array contains operations', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.contains('urls', 'https://example.com');

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length > 0);
  const containsPredicate = qb._where[0];
  t.is(containsPredicate.operator, '@>');
  t.deepEqual(containsPredicate.value, ['https://example.com']);

  const { sql, params } = qb._buildSelectQuery();
  t.true(sql.includes('::text[]'));
  t.deepEqual(params, [['https://example.com']]);
});

test('QueryBuilder supports simple joins', t => {
  const mockModel = createMockModel({ tableName: 'reviews' });
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  const result = qb.getJoin({ thing: true });

  t.is(result, qb); // Should return self for chaining
  t.truthy(qb._joinSpecs);
  t.is(qb._joinSpecs.length, 1);
  t.deepEqual(qb._joinSpecs[0], { thing: true });
});

test('QueryBuilder supports complex joins with _apply', t => {
  const mockModel = createMockModel({ tableName: 'reviews' });
  const mockDAL = createMockDAL();

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
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });
  qb.orderBy('created_on', 'DESC');
  qb.limit(10);
  qb.offset(5);

  const { sql: selectSql, params: selectParams } = qb._buildSelectQuery();

  t.true(selectSql.includes('SELECT'));
  t.true(selectSql.includes('FROM test_table'));
  t.true(selectSql.includes('WHERE'));
  t.true(selectSql.includes('ORDER BY test_table.created_on DESC'));
  t.true(selectSql.includes('LIMIT 10'));
  t.true(selectSql.includes('OFFSET 5'));
  t.deepEqual(selectParams, ['test-id']);
});

test('QueryBuilder builds COUNT queries correctly', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });

  const { sql: countSql, params: countParams } = qb._buildCountQuery();

  t.true(countSql.includes('SELECT COUNT(*)'));
  t.true(countSql.includes('FROM test_table'));
  t.true(countSql.includes('WHERE'));
  t.deepEqual(countParams, ['test-id']);
});

test('QueryBuilder builds DELETE queries correctly', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

  const qb = new QueryBuilder(mockModel, mockDAL);
  qb.filter({ id: 'test-id' });

  const { sql: deleteSql, params: deleteParams } = qb._buildDeleteQuery();

  t.true(deleteSql.includes('DELETE FROM test_table'));
  t.true(deleteSql.includes('WHERE'));
  t.deepEqual(deleteParams, ['test-id']);
});

test('QueryBuilder handles join information lookup', t => {
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
  } as any;
  const mockDAL = createMockDAL();

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

test('QueryBuilder handles schema namespace prefixing', t => {
  const mockModel = createMockModel();
  const mockDAL = { schemaNamespace: 'test_schema.' } as any;

  const qb = new QueryBuilder(mockModel, mockDAL);

  const tableName = qb._getTableName('users');
  t.is(tableName, 'test_schema.users');

  // Test without namespace
  const mockDALNoNamespace = createMockDAL();
  const qb2 = new QueryBuilder(mockModel, mockDALNoNamespace);
  const tableName2 = qb2._getTableName('users');
  t.is(tableName2, 'users');
});

test('QueryBuilder method chaining works correctly', t => {
  const mockModel = createMockModel();
  const mockDAL = createMockDAL();

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
  const dalTypes = dalModule.types;
  const BaseModel = Model;

  const capturedQueries = [];
  const mockDAL = {
    schemaNamespace: '',
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
  } as any;

  const { model: TestModel } = initializeModel({
    dal: mockDAL,
    baseTable: 'tmp_models',
    schema: {
      id: dalTypes.string(),
      camelCaseField: dalTypes.string().default('fallback')
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

test('Model.getSafeColumnNames excludes sensitive fields', t => {
    const types = typesLib;

  const mockDAL = {
    schemaNamespace: '',
    query: async () => ({ rows: [] })
  } as any;

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string()
  };

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL);
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const safeColumns = TestModel.getSafeColumnNames();

  t.true(safeColumns.includes('id'));
  t.true(safeColumns.includes('name'));
  t.true(safeColumns.includes('email'));
  t.false(safeColumns.includes('password'), 'Password should be excluded from safe columns');
});

test('Model.getColumnNames includes sensitive fields when requested', t => {
    const types = typesLib;

  const mockDAL = {
    schemaNamespace: '',
    query: async () => ({ rows: [] })
  } as any;

    const schema = {
      id: types.string(),
      name: types.string(),
      password: types.string().sensitive(),
      token: types.string().sensitive(),
      email: types.string()
  };

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL);
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('token', 'token');
  TestModel._registerFieldMapping('email', 'email');

  const allColumns = TestModel.getColumnNames(['password', 'token']);

  t.true(allColumns.includes('id'));
  t.true(allColumns.includes('name'));
  t.true(allColumns.includes('email'));
  t.true(allColumns.includes('password'), 'Password should be included when explicitly requested');
  t.true(allColumns.includes('token'), 'Token should be included when explicitly requested');
});

test('Model.getSensitiveFieldNames returns all sensitive fields', t => {
    const types = typesLib;

  const mockDAL = {
    schemaNamespace: '',
    query: async () => ({ rows: [] })
  } as any;

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    token: types.string().sensitive(),
    apiKey: types.string().sensitive(),
    email: types.string()
  };

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL);

  const sensitiveFields = TestModel.getSensitiveFieldNames();

  t.is(sensitiveFields.length, 3);
  t.true(sensitiveFields.includes('password'));
  t.true(sensitiveFields.includes('token'));
  t.true(sensitiveFields.includes('apiKey'));
  t.false(sensitiveFields.includes('id'));
  t.false(sensitiveFields.includes('name'));
  t.false(sensitiveFields.includes('email'));
});

test('QueryBuilder excludes sensitive fields from SELECT by default', t => {
      const types = typesLib;

  const mockDAL = {
    schemaNamespace: '',
    query: async () => ({ rows: [] })
  } as any;

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string()
  };

  const TestModel = Model.createModel('users', schema, {}, mockDAL);
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder(TestModel, mockDAL);
  qb.filter({ id: 'test-id' });

  const { sql } = qb._buildSelectQuery();

  t.true(sql.includes('users.id'));
  t.true(sql.includes('users.name'));
  t.true(sql.includes('users.email'));
  t.false(sql.includes('users.password'), 'Password should not be in SELECT clause');
});

test('QueryBuilder includes sensitive fields when includeSensitive is called', t => {
      const types = typesLib;

  const mockDAL = {
    schemaNamespace: '',
    query: async () => ({ rows: [] })
  } as any;

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string()
  };

  const TestModel = Model.createModel('users', schema, {}, mockDAL);
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder(TestModel, mockDAL);
  qb.filter({ id: 'test-id' });
  qb.includeSensitive(['password']);

  const { sql } = qb._buildSelectQuery();

  t.true(sql.includes('users.id'));
  t.true(sql.includes('users.name'));
  t.true(sql.includes('users.email'));
  t.true(sql.includes('users.password'), 'Password should be included when explicitly requested');
});

test('QueryBuilder.includeSensitive accepts string or array', t => {
    const mockModel = createMockModel({ getColumnNames: () => ['id', 'name'] });
  const mockDAL = createMockDAL();

  const qb1 = new QueryBuilder(mockModel, mockDAL);
  qb1.includeSensitive('password');
  t.deepEqual(qb1._includeSensitive, ['password']);

  const qb2 = new QueryBuilder(mockModel, mockDAL);
  qb2.includeSensitive(['password', 'token']);
  t.deepEqual(qb2._includeSensitive, ['password', 'token']);
});
