import type { PostgresConfig } from 'config';

import DataAccessLayer from './lib/data-access-layer.js';
import Model from './lib/model.js';
import QueryBuilder from './lib/query-builder.js';
import types from './lib/type.js';
import Errors from './lib/errors.js';
import mlString from './lib/ml-string.js';
import revision from './lib/revision.js';

/**
 * Data Access Layer (DAL) for PostgreSQL
 * 
 * This module provides the main entry point for the PostgreSQL DAL,
 * abstracting database operations and providing a consistent interface
 * for all database interactions.
 */

type DataAccessLayerClass = new (config?: Partial<PostgresConfig>) => Record<string, unknown>;

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

const createDataAccessLayer = ((config?: Partial<PostgresConfig>) => new DataAccessLayerCtor(config)) as CreateDataAccessLayer;

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
  createDataAccessLayer
};

export default createDataAccessLayer;
