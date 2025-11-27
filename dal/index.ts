import type { PostgresConfig } from 'config';

import DataAccessLayer from './lib/data-access-layer.ts';
import Errors from './lib/errors.ts';
import mlString from './lib/ml-string.ts';
import Model from './lib/model.ts';
import type { JoinApplyBuilder, JoinOptions, JoinRelationOptions } from './lib/query-builder.ts';
import QueryBuilder from './lib/query-builder.ts';
import revision from './lib/revision.ts';
import types from './lib/type.ts';

/**
 * Data Access Layer (DAL) for PostgreSQL
 *
 * This module provides the main entry point for the PostgreSQL DAL,
 * abstracting database operations and providing a consistent interface
 * for all database interactions.
 */

type DataAccessLayerClass = typeof DataAccessLayer;

type DataAccessLayerInstance = InstanceType<DataAccessLayerClass>;

export type DalContext = DataAccessLayerInstance & {
  cleanup?: (options?: { dropSchema?: boolean }) => Promise<void>;
  schemaNamespace?: string;
};

const DataAccessLayerCtor = DataAccessLayer as unknown as DataAccessLayerClass;

type CreateDataAccessLayer = ((config?: Partial<PostgresConfig>) => DataAccessLayerInstance) & {
  DataAccessLayer: DataAccessLayerClass;
  Model: typeof Model;
  QueryBuilder: typeof QueryBuilder;
  types: typeof types;
  Errors: typeof Errors;
  mlString: typeof mlString;
  revision: typeof revision;
};

/**
 * Create a PostgreSQL Data Access Layer (DAL) instance.
 *
 * @param config Optional PostgreSQL configuration overrides used to initialize the DAL instance.
 * @returns A ready-to-use DAL instance bound to the provided configuration.
 */
const createDataAccessLayer = ((config?: Partial<PostgresConfig>) =>
  new DataAccessLayerCtor(config)) as CreateDataAccessLayer;

createDataAccessLayer.DataAccessLayer = DataAccessLayerCtor;
createDataAccessLayer.Model = Model;
createDataAccessLayer.QueryBuilder = QueryBuilder;
createDataAccessLayer.types = types;
createDataAccessLayer.Errors = Errors;
createDataAccessLayer.mlString = mlString;
createDataAccessLayer.revision = revision;

export {
  DataAccessLayer,
  Model,
  QueryBuilder,
  types,
  Errors,
  mlString,
  revision,
  createDataAccessLayer,
};

export type { JoinApplyBuilder, JoinOptions, JoinRelationOptions };

export default createDataAccessLayer;
