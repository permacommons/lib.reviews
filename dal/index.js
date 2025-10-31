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

function createDataAccessLayer(config) {
  return new DataAccessLayer(config);
}

createDataAccessLayer.DataAccessLayer = DataAccessLayer;
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
