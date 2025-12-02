import type { Pool, PoolClient, QueryResult } from 'pg';
import Model, { type ModelSchema } from '../../dal/lib/model.ts';
import {
  type InitializeModelResult,
  initializeModel,
  type RelationConfig,
} from '../../dal/lib/model-initializer.ts';
import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance,
} from '../../dal/lib/model-types.ts';
import QueryBuilder from '../../dal/lib/query-builder.ts';
import typesLib from '../../dal/lib/type.ts';

export type RuntimeModel = InitializeModelResult<
  JsonObject,
  JsonObject,
  Model<JsonObject, JsonObject>
>['model'] &
  typeof Model;

type RelationDefinition = RelationConfig & { name: string };

interface MockModelOptions {
  tableName?: string;
  schema?: ModelSchema<JsonObject, JsonObject>;
  camelToSnake?: Record<string, string>;
  relations?: RelationDefinition[];
  configure?: (model: RuntimeModel) => void;
}

interface QueryBuilderSetupOptions extends MockModelOptions {
  dalOverrides?: Partial<DataAccessLayer>;
}

type QueryBuilderArgs = ConstructorParameters<typeof QueryBuilder>;

export const defaultSchema = (): ModelSchema<JsonObject, JsonObject> => {
  return {
    id: typesLib.string(),
    name: typesLib.string(),
    created_on: typesLib.string(),
  } as unknown as ModelSchema<JsonObject, JsonObject>;
};

export const createQueryResult = <TRow extends JsonObject>(rows: TRow[] = []) =>
  ({
    command: '',
    rowCount: rows.length,
    oid: 0,
    rows,
    fields: [],
  }) satisfies QueryResult<TRow>;

export const createMockDAL = (overrides: Partial<DataAccessLayer> = {}): DataAccessLayer => {
  const registeredModels = new Map<string, ModelConstructor>();

  const dal: DataAccessLayer = {
    schemaNamespace: '',
    async connect() {
      return dal;
    },
    async disconnect() {
      // No-op for test doubles
    },
    async migrate() {
      // No-op for test doubles
    },
    async rollback() {
      // No-op for test doubles
    },
    async query<T extends JsonObject = JsonObject>(
      _sql?: string,
      _params: unknown[] = [],
      _client?: Pool | PoolClient | null
    ) {
      return createQueryResult<T>();
    },
    getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
      name: string
    ) {
      const model = registeredModels.get(name);
      if (!model) {
        throw new Error(`Model '${name}' not found in mock DAL`);
      }
      return model as ModelConstructor<TRecord, TVirtual>;
    },
    createModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
      name: string,
      schema,
      options = {}
    ) {
      const runtimeSchema = schema as unknown as ModelSchema<JsonObject, JsonObject>;
      const model = Model.createModel<JsonObject, JsonObject>(name, runtimeSchema, options, dal);
      registeredModels.set(name, model);
      return model as ModelConstructor<TRecord, TVirtual>;
    },
    getRegisteredModels() {
      return registeredModels;
    },
    getModelRegistry() {
      return registeredModels;
    },
  };

  Object.assign(dal, overrides);
  dal.schemaNamespace = overrides.schemaNamespace ?? dal.schemaNamespace ?? '';

  return dal;
};

export const createMockModel = (
  dal: DataAccessLayer,
  options: MockModelOptions = {}
): RuntimeModel => {
  const {
    tableName = 'test_table',
    schema = defaultSchema(),
    camelToSnake = { createdOn: 'created_on' },
    relations = [],
    configure,
  } = options;

  const { model } = initializeModel<JsonObject, JsonObject, Model<JsonObject, JsonObject>>({
    dal,
    baseTable: tableName,
    schema,
    camelToSnake,
    relations,
  });

  const runtimeModel = model as RuntimeModel;
  const registry = dal.getRegisteredModels();
  registry.set(tableName, runtimeModel);
  const resolvedTableName = runtimeModel.tableName;
  if (resolvedTableName && resolvedTableName !== tableName) {
    registry.set(resolvedTableName, runtimeModel);
  }

  configure?.(runtimeModel);

  return runtimeModel;
};

export const createQueryBuilderHarness = <
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TData, TVirtual> = ModelInstance<TData, TVirtual>,
  TRelations extends string = string,
>(
  options: QueryBuilderSetupOptions = {}
) => {
  const dal = createMockDAL(options.dalOverrides);
  const model = createMockModel(dal, options);
  const qb = new QueryBuilder(model as unknown as QueryBuilderArgs[0], dal);
  return {
    qb: qb as unknown as QueryBuilder<TData, TVirtual, TInstance, TRelations>,
    model,
    dal,
  };
};
