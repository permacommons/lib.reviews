import DataAccessLayer from './lib/data-access-layer.mjs';
import Model from './lib/model.mjs';
import QueryBuilder from './lib/query-builder.mjs';
import type from './lib/type.mjs';
import Errors from './lib/errors.mjs';
import mlString from './lib/ml-string.mjs';
import revision from './lib/revision.mjs';

/**
 * Data Access Layer (DAL) for PostgreSQL
 * 
 * This module provides the main entry point for the PostgreSQL DAL,
 * abstracting database operations and providing a consistent interface
 * for all database interactions.
 */

function createDataAccessLayer(config) {
  return new DataAccessLayer(config);
}

createDataAccessLayer.DataAccessLayer = DataAccessLayer;
createDataAccessLayer.Model = Model;
createDataAccessLayer.QueryBuilder = QueryBuilder;
createDataAccessLayer.type = type;
createDataAccessLayer.Errors = Errors;
createDataAccessLayer.mlString = mlString;
createDataAccessLayer.revision = revision;

export {
  DataAccessLayer,
  Model,
  QueryBuilder,
  type,
  Errors,
  mlString,
  revision,
  createDataAccessLayer
};

export default createDataAccessLayer;
