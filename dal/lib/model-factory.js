'use strict';

/**
 * Model factory helpers for the PostgreSQL DAL.
 */

/**
 * Return an existing model for the given table name if it has already been
 * registered on the provided DAL instance. Otherwise, create the model using
 * the supplied schema and options.
 *
 * @param {DataAccessLayer} dal - The DAL instance that owns the model.
 * @param {string} tableName - Fully qualified table name (with prefix if any).
 * @param {Object} schema - Schema definition passed to createModel.
 * @param {Object} [options={}] - Additional options passed to createModel.
 * @returns {{ model: Function, isNew: boolean }} The model constructor and a
 *  flag indicating whether it was created by this call.
 */
function getOrCreateModel(dal, tableName, schema, options = {}) {
  let existingModel = null;

  if (dal && typeof dal.getModel === 'function') {
    try {
      existingModel = dal.getModel(tableName);
    } catch (error) {
      const notFound = /Model '.*' not found/.test(error?.message || '');
      if (!notFound) {
        throw error;
      }
    }
  }

  if (existingModel) {
    return { model: existingModel, isNew: false };
  }

  const model = dal.createModel(tableName, schema, options);
  return { model, isNew: true };
}

module.exports = {
  getOrCreateModel
};
