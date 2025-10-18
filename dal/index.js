'use strict';

/**
 * Data Access Layer (DAL) for PostgreSQL
 * 
 * This module provides the main entry point for the PostgreSQL DAL,
 * abstracting database operations and providing a consistent interface
 * for all database interactions.
 */

const DataAccessLayer = require('./lib/data-access-layer');
const Model = require('./lib/model');
const QueryBuilder = require('./lib/query-builder');
const type = require('./lib/type');
const Errors = require('./lib/errors');
const mlString = require('./lib/ml-string');

module.exports = function(config) {
  return new DataAccessLayer(config);
};

// Export classes and utilities
module.exports.DataAccessLayer = DataAccessLayer;
module.exports.Model = Model;
module.exports.QueryBuilder = QueryBuilder;
module.exports.type = type;
module.exports.Errors = Errors;
module.exports.mlString = mlString;