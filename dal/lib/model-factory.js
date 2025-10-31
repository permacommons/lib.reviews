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
  const { registryKey, ...modelOptions } = options;
  const lookupKeys = [];

  if (registryKey && typeof registryKey === 'string') {
    lookupKeys.push(registryKey);
  }

  if (tableName) {
    lookupKeys.push(tableName);
  }

  let existingModel = null;

  if (dal && typeof dal.getModel === 'function') {
    for (const key of lookupKeys) {
      if (!key) continue;
      try {
        existingModel = dal.getModel(key);
        if (existingModel) {
          break;
        }
      } catch (error) {
        const notFound = /Model '.*' not found/.test(error?.message || '');
        if (!notFound) {
          throw error;
        }
      }
    }
  }

  if (existingModel) {
    return { model: existingModel, isNew: false };
  }

  const model = dal.createModel(tableName, schema, { ...modelOptions, registryKey });
  return { model, isNew: true };
}

const factory = { getOrCreateModel };

export { getOrCreateModel };
export default factory;

