import test from 'ava';

import * as dalModule from '../dal/index.ts';
import Model, { type ModelSchema } from '../dal/lib/model.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';
import type { JsonObject, ModelInstance } from '../dal/lib/model-types.ts';
import QueryBuilder from '../dal/lib/query-builder.ts';
import typesLib from '../dal/lib/type.ts';
import { FilterWhereBuilder, createOperators } from '../dal/lib/filter-where.ts';
import type { RuntimeModel } from './helpers/dal-mocks.ts';
import {
  createMockDAL,
  createQueryBuilderHarness,
  createQueryResult,
} from './helpers/dal-mocks.ts';

type QueryBuilderArgs = ConstructorParameters<typeof QueryBuilder>;

type DefaultRecord = {
  id: string;
  name?: string;
  createdOn?: string;
};
type DefaultInstance = ModelInstance<DefaultRecord, JsonObject>;
type RevisionRecord = DefaultRecord & { _revID?: string };
type RevisionInstance = ModelInstance<RevisionRecord, JsonObject>;

/**
 * Unit tests for QueryBuilder functionality
 *
 * Tests the query builder methods without requiring database connection
 */

test('QueryBuilder can be instantiated', t => {
  const { qb } = createQueryBuilderHarness();
  t.truthy(qb);
  t.is(qb.tableName, 'test_table');
});

test('FilterWhereBuilder applies literal predicates to QueryBuilder', t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );

  const result = builder.and({ id: 'test-id' });

  t.is(result, builder, 'FilterWhereBuilder.and should return the builder instance');
  t.is(qb._where.length, 1);
  const predicate = qb._where[0];
  if (predicate?.type !== 'basic') {
    t.fail('Expected FilterWhereBuilder to add a basic predicate for literal values');
    return;
  }
  t.is(predicate.column, 'id');
  t.is(predicate.operator, '=');
  t.is(predicate.value, 'test-id');
});

test('QueryBuilder supports orderBy method', t => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.orderBy('created_on', 'DESC');

  t.is(result, qb); // Should return self for chaining
  t.true(qb._orderBy.length > 0);
  t.is(qb._orderBy[0], 'created_on DESC');
});

test('FilterWhereBuilder resolves manifest keys before delegating', t => {
  const schema = {
    id: typesLib.string(),
    createdOn: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness({
    schema,
    camelToSnake: { createdOn: 'created_on' },
  });

  type Data = { id: string; createdOn: string };
  type Instance = ModelInstance<Data, JsonObject>;

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);

  builder.orderBy('createdOn', 'DESC').whereIn('id', ['a', 'b']);

  t.deepEqual(qb._orderBy, ['created_on DESC']);
  const predicate = qb._where[0] as { column: string } | undefined;
  t.truthy(predicate);
  t.is(predicate?.column, 'id');
});

test('FilterWhere operator helpers build advanced predicates', t => {
  type Data = {
    id: string;
    status: string;
    score: number;
    createdOn: Date;
    isActive: boolean | null;
    metadata: JsonObject;
  };
  type Instance = ModelInstance<Data, JsonObject>;

  const schema = {
    id: typesLib.string(),
    status: typesLib.string(),
    score: typesLib.number(),
    created_on: typesLib.date(),
    is_active: typesLib.boolean(),
    metadata: typesLib.object(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness({
    schema,
    camelToSnake: { createdOn: 'created_on', isActive: 'is_active' },
  });

  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  const ops = createOperators<Data>();

  builder
    .and({
      status: ops.in(['draft', 'published']),
      id: ops.in(['one'], { cast: 'uuid[]' }),
    })
    .and({ score: ops.between(10, 20, { leftBound: 'open', rightBound: 'closed' }) })
    .and({ score: ops.notBetween(30, 40, { leftBound: 'open', rightBound: 'open' }) })
    .and({ metadata: ops.jsonContains({ foo: 'bar' }) })
    .and({ isActive: ops.not() });

  t.is(qb._where.length, 6);

  const [
    anyPredicate,
    castPredicate,
    betweenGroup,
    notBetweenGroup,
    jsonPredicate,
    booleanPredicate,
  ] = qb._where;

  if (!anyPredicate || anyPredicate.type !== 'basic') {
    t.fail('Expected first predicate to be basic');
    return;
  }
  t.is(anyPredicate.operator, '= ANY');
  t.deepEqual(anyPredicate.value, ['draft', 'published']);
  t.truthy(anyPredicate.valueTransform);
  t.is(anyPredicate.valueTransform?.('__value__'), '(__value__)');

  if (!castPredicate || castPredicate.type !== 'basic') {
    t.fail('Expected second predicate to be basic');
    return;
  }
  t.is(castPredicate.operator, '= ANY');
  t.deepEqual(castPredicate.value, ['one']);
  t.is(castPredicate.valueTransform?.('__value__'), '(__value__::uuid[])');

  if (!betweenGroup || betweenGroup.type !== 'group') {
    t.fail('Expected third predicate to be a group');
    return;
  }
  t.is(betweenGroup.conjunction, 'AND');
  const [lowerBetween, upperBetween] = betweenGroup.predicates;
  t.truthy(lowerBetween && upperBetween);
  if (lowerBetween?.type === 'basic' && upperBetween?.type === 'basic') {
    t.is(lowerBetween.operator, '>');
    t.is(upperBetween.operator, '<=');
    t.is(lowerBetween.value, 10);
    t.is(upperBetween.value, 20);
  } else {
    t.fail('Between group predicates should be basic');
  }

  if (!notBetweenGroup || notBetweenGroup.type !== 'group') {
    t.fail('Expected fourth predicate to be a group');
    return;
  }
  t.is(notBetweenGroup.conjunction, 'OR');
  const [lowerNotBetween, upperNotBetween] = notBetweenGroup.predicates;
  t.truthy(lowerNotBetween && upperNotBetween);
  if (lowerNotBetween?.type === 'basic' && upperNotBetween?.type === 'basic') {
    t.is(lowerNotBetween.operator, '<=');
    t.is(upperNotBetween.operator, '>=');
    t.is(lowerNotBetween.value, 30);
    t.is(upperNotBetween.value, 40);
  } else {
    t.fail('NotBetween group predicates should be basic');
  }

  if (!jsonPredicate || jsonPredicate.type !== 'basic') {
    t.fail('Expected fifth predicate to be basic');
    return;
  }
  t.is(jsonPredicate.operator, '@>');
  t.is(jsonPredicate.value, JSON.stringify({ foo: 'bar' }));
  t.is(jsonPredicate.valueTransform?.('__value__'), '__value__::jsonb');

  if (!booleanPredicate || booleanPredicate.type !== 'basic') {
    t.fail('Expected sixth predicate to be basic');
    return;
  }
  t.is(booleanPredicate.operator, 'IS NOT');
  t.true(booleanPredicate.value);
  t.is(booleanPredicate.valueTransform?.('__value__'), '__value__');
});

test('FilterWhere operators enforce non-empty IN arrays at runtime', t => {
  type MinimalRecord = JsonObject & { id: string };
  const ops = createOperators<MinimalRecord>();
  t.throws(() => ops.in([] as unknown as [string, ...string[]]), {
    message: /requires at least one value/i,
  });
});

test('FilterWhere between participates in OR groups', t => {
  type Data = { value: number };
  type Instance = ModelInstance<Data, JsonObject>;

  const schema = {
    value: typesLib.number(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness({ schema });
  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, false);
  const ops = createOperators<Data>();

  builder.or({ value: ops.between(1, 5) });

  t.is(qb._where.length, 1);
  const groupPredicate = qb._where[0];
  if (groupPredicate?.type !== 'group') {
    t.fail('Expected OR predicate to be grouped');
    return;
  }
  t.is(groupPredicate.conjunction, 'OR');
  t.is(groupPredicate.predicates.length, 1);
  const nested = groupPredicate.predicates[0];
  if (nested?.type !== 'group') {
    t.fail('Expected nested between group');
    return;
  }
  t.is(nested.conjunction, 'AND');
});

test('QueryBuilder supports limit method', t => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.limit(10);

  t.is(result, qb); // Should return self for chaining
  t.is(qb._limit, 10);
});

test('QueryBuilder supports offset method', t => {
  const { qb } = createQueryBuilderHarness();
  const result = qb.offset(5);

  t.is(result, qb); // Should return self for chaining
  t.is(qb._offset, 5);
});

test('FilterWhereBuilder enforces revision guards before execution', async t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  await builder.run();

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  t.truthy(oldRevisionPredicate);
  t.is(oldRevisionPredicate?.operator, 'IS');

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  t.truthy(deletedPredicate);
  t.is(deletedPredicate?.operator, '=');
  t.false(deletedPredicate?.value);
});

test('FilterWhereBuilder can include deleted and stale revisions on demand', async t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  await builder.includeDeleted().includeStale().run();

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  t.falsy(oldRevisionPredicate);

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  t.falsy(deletedPredicate);
});

test('FilterWhereBuilder sample enforces revision guards before delegating', async t => {
  type Data = JsonObject & { id: string };
  type Instance = ModelInstance<Data, JsonObject>;

  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<Data, JsonObject, Instance, string>(qb, true);

  const sampleRows = [{ id: 'example' }];
  let delegatedCount: number | undefined;

  const originalSample = qb.sample.bind(qb);
  type SampleReturn = Awaited<ReturnType<typeof originalSample>>;

  qb.sample = (async (count = 1) => {
    delegatedCount = count;
    return sampleRows as unknown as SampleReturn;
  }) as typeof qb.sample;

  const results = await builder.sample(2);

  t.is(delegatedCount, 2);
  t.is(results, sampleRows as unknown as Instance[]);

  const oldRevisionPredicate = qb._where.find(predicate => predicate.column === '_old_rev_of');
  t.truthy(oldRevisionPredicate);
  t.is(oldRevisionPredicate.operator, 'IS');

  const deletedPredicate = qb._where.find(predicate => predicate.column === '_rev_deleted');
  t.truthy(deletedPredicate);
  t.is(deletedPredicate.operator, '=');
  t.false(deletedPredicate.value);
});

test('FilterWhereBuilder.revisionData applies revision predicates', t => {
  const schema = {
    id: typesLib.string(),
    name: typesLib.string(),
    created_on: typesLib.string(),
    _rev_id: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const { qb } = createQueryBuilderHarness({
    schema,
    camelToSnake: { createdOn: 'created_on', _revID: '_rev_id' },
  });

  const builder = new FilterWhereBuilder<RevisionRecord, JsonObject, RevisionInstance, string>(
    qb,
    true
  );

  const revId = 'rev-123';
  builder.revisionData({ _revID: revId });

  const predicate = qb._where.find(entry => entry.column === '_rev_id');
  t.truthy(predicate);
  t.is(predicate?.operator, '=');
  t.is(predicate?.value, revId);
});

test('QueryBuilder supports revision tag filtering', t => {
  const { qb } = createQueryBuilderHarness();
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
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');

  const { qb } = createQueryBuilderHarness();
  const result = qb.between(startDate, endDate);

  t.is(result, qb); // Should return self for chaining
  t.true(qb._where.length >= 2); // Should have start and end conditions
  const { params: betweenParams } = qb._buildSelectQuery();
  t.true(betweenParams.includes(startDate));
  t.true(betweenParams.includes(endDate));
});

test('QueryBuilder supports array contains operations', t => {
  const { qb } = createQueryBuilderHarness();
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
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'thing',
        targetTable: 'things',
        sourceColumn: 'thing_id',
        hasRevisions: true,
      },
    ],
  });
  const result = qb.getJoin({ thing: true });

  t.is(result, qb); // Should return self for chaining
  t.truthy(qb._joinSpecs);
  t.is(qb._joinSpecs.length, 1);
  t.deepEqual(qb._joinSpecs[0], { thing: true });
});

test('QueryBuilder supports complex joins with _apply', t => {
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'creator',
        targetTable: 'users',
        sourceColumn: 'created_by',
        hasRevisions: false,
      },
    ],
  });

  const result = qb.getJoin({
    creator: {
      _apply: seq => seq.without('password'),
    },
  });

  t.is(result, qb); // Should return self for chaining
  t.truthy(qb._joinSpecs);
  t.is(qb._joinSpecs.length, 1);
  const joinSpec = qb._joinSpecs?.[0];
  t.truthy(joinSpec);
  if (joinSpec && typeof joinSpec === 'object' && 'creator' in joinSpec) {
    const creatorSpec = joinSpec.creator;
    if (creatorSpec && typeof creatorSpec === 'object' && '_apply' in creatorSpec) {
      t.true(typeof creatorSpec._apply === 'function');
    } else {
      t.fail('Creator join spec missing _apply handler');
    }
  }
});

test('QueryBuilder builds SELECT queries correctly', t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });
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
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql: countSql, params: countParams } = qb._buildCountQuery();

  t.true(countSql.includes('SELECT COUNT(*)'));
  t.true(countSql.includes('FROM test_table'));
  t.true(countSql.includes('WHERE'));
  t.deepEqual(countParams, ['test-id']);
});

test('QueryBuilder builds DELETE queries correctly', t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql: deleteSql, params: deleteParams } = qb._buildDeleteQuery();

  t.true(deleteSql.includes('DELETE FROM test_table'));
  t.true(deleteSql.includes('WHERE'));
  t.deepEqual(deleteParams, ['test-id']);
});

test('QueryBuilder handles join information lookup', t => {
  const { qb } = createQueryBuilderHarness({
    tableName: 'reviews',
    relations: [
      {
        name: 'thing',
        targetTable: 'things',
        sourceColumn: 'thing_id',
        hasRevisions: true,
      },
      {
        name: 'creator',
        targetTable: 'users',
        sourceColumn: 'created_by',
        hasRevisions: false,
      },
    ],
  });

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
  const { qb } = createQueryBuilderHarness({
    dalOverrides: { schemaNamespace: 'test_schema.' },
  });

  const tableName = qb._getTableName('users');
  t.is(tableName, 'test_schema.users');

  // Test without namespace
  const { qb: qb2 } = createQueryBuilderHarness();
  const tableName2 = qb2._getTableName('users');
  t.is(tableName2, 'users');
});

test('FilterWhereBuilder method chaining works correctly', t => {
  const { qb } = createQueryBuilderHarness();
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    true
  );

  const result = builder
    .and({ id: 'active-record' })
    .orderBy('createdOn', 'DESC')
    .limit(10)
    .offset(5)
    .getJoin({ creator: true });

  t.is(result, builder); // Should return the same builder instance
  t.true(qb._where.length > 0);
  t.true(qb._orderBy.length > 0);
  t.is(qb._limit, 10);
  t.is(qb._offset, 5);
  t.truthy(qb._joinSpecs);
});

test('Model constructor maps camelCase fields to snake_case columns', async t => {
  const dalTypes = dalModule.types;
  const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
  const mockDAL = createMockDAL({
    async query<TRecord extends JsonObject = JsonObject>(
      sql: string,
      params: unknown[] = [],
      _client?: import('pg').Pool | import('pg').PoolClient | null
    ) {
      capturedQueries.push({ sql, params });
      const row = { id: 'generated-id', camel_case_field: params[0] } as unknown as TRecord;
      return createQueryResult<TRecord>([row]);
    },
  });

  const { model: TestModel } = initializeModel({
    dal: mockDAL,
    baseTable: 'tmp_models',
    schema: {
      id: dalTypes.string(),
      camelCaseField: dalTypes.string().default('fallback'),
    },
    camelToSnake: {
      camelCaseField: 'camel_case_field',
    },
  });

  const instance = new TestModel({ camelCaseField: 'value' });

  t.is(instance._data['camel_case_field'], 'value');
  t.false(Object.prototype.hasOwnProperty.call(instance._data, 'camelCaseField'));

  await instance.save();

  t.true(capturedQueries[0].sql.includes('camel_case_field'));
  t.deepEqual(capturedQueries[0].params, ['value']);

  const defaultedInstance = new TestModel();
  t.is(defaultedInstance._data['camel_case_field'], 'fallback');
});

test('Model.getSafeColumnNames excludes sensitive fields', t => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;
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
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    token: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;
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
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    token: types.string().sensitive(),
    apiKey: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('test_table', schema, {}, mockDAL) as unknown as typeof Model;

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
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('users', schema, {}, mockDAL) as RuntimeModel;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder(TestModel as unknown as QueryBuilderArgs[0], mockDAL);
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });

  const { sql } = qb._buildSelectQuery();

  t.true(sql.includes('users.id'));
  t.true(sql.includes('users.name'));
  t.true(sql.includes('users.email'));
  t.false(sql.includes('users.password'), 'Password should not be in SELECT clause');
});

test('QueryBuilder includes sensitive fields when includeSensitive is called', t => {
  const types = typesLib;
  const mockDAL = createMockDAL();

  const schema = {
    id: types.string(),
    name: types.string(),
    password: types.string().sensitive(),
    email: types.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;

  const TestModel = Model.createModel('users', schema, {}, mockDAL) as RuntimeModel;
  TestModel._registerFieldMapping('name', 'name');
  TestModel._registerFieldMapping('password', 'password');
  TestModel._registerFieldMapping('email', 'email');

  const qb = new QueryBuilder(TestModel as unknown as QueryBuilderArgs[0], mockDAL);
  const builder = new FilterWhereBuilder<DefaultRecord, JsonObject, DefaultInstance, string>(
    qb,
    false
  );
  builder.and({ id: 'test-id' });
  qb.includeSensitive(['password']);

  const { sql } = qb._buildSelectQuery();

  t.true(sql.includes('users.id'));
  t.true(sql.includes('users.name'));
  t.true(sql.includes('users.email'));
  t.true(sql.includes('users.password'), 'Password should be included when explicitly requested');
});

test('QueryBuilder.includeSensitive accepts string or array', t => {
  const { qb: qb1 } = createQueryBuilderHarness();
  qb1.includeSensitive('password');
  t.deepEqual(qb1._includeSensitive, ['password']);

  const { qb: qb2 } = createQueryBuilderHarness();
  qb2.includeSensitive(['password', 'token']);
  t.deepEqual(qb2._includeSensitive, ['password', 'token']);
});
