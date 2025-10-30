'use strict';

/**
 * ModelRegistry maintains the mapping between a DAL instance and the models
 * registered on it. Each registry enforces one-time registration per DAL
 * instance, preventing duplicate bindings for the same table or logical key.
 */
class ModelRegistry {
  constructor(ownerDAL) {
    this.ownerDAL = ownerDAL;
    this.modelsByTable = new Map();
    this.modelsByKey = new Map();
  }

  /**
   * Register a model with the registry.
   *
   * @param {string} tableName - Fully qualified table name for the model.
   * @param {Function} model - Model constructor returned by createModel.
   * @param {Object} [options]
   * @param {string} [options.key] - Canonical lookup key (defaults to tableName).
   * @returns {Function} The registered model constructor.
   */
  register(tableName, model, options = {}) {
    if (!tableName || typeof tableName !== 'string') {
      throw new Error('Model registry requires a valid tableName.');
    }

    if (typeof model !== 'function') {
      throw new Error('Model registry can only register constructor functions.');
    }

    const canonicalKey = options.key || tableName;

    const existingByTable = this.modelsByTable.get(tableName);
    if (existingByTable && existingByTable !== model) {
      throw new Error(`Model '${tableName}' already registered on this DAL instance.`);
    }

    const existingByKey = this.modelsByKey.get(canonicalKey);
    if (existingByKey && existingByKey !== model) {
      throw new Error(`Model registry key '${canonicalKey}' already registered on this DAL instance.`);
    }

    this.modelsByTable.set(tableName, model);
    this.modelsByKey.set(canonicalKey, model);

    return model;
  }

  /**
   * Retrieve a registered model by table name or canonical key.
   *
   * @param {string} identifier - Table name or registry key.
   * @returns {Function|null} The registered model or null if not found.
   */
  get(identifier) {
    if (!identifier) {
      return null;
    }

    return this.modelsByTable.get(identifier) || this.modelsByKey.get(identifier) || null;
  }

  /**
   * Return true if a model has been registered under the provided identifier.
   *
   * @param {string} identifier - Table name or registry key.
   * @returns {boolean}
   */
  has(identifier) {
    return this.get(identifier) !== null;
  }

  /**
   * Return a shallow copy of the registry keyed by canonical names.
   *
   * @returns {Map<string, Function>} Map of canonical keys to model constructors.
   */
  listByKey() {
    return new Map(this.modelsByKey);
  }

  /**
   * Return a shallow copy of the registry keyed by table names.
   *
   * @returns {Map<string, Function>} Map of table names to model constructors.
   */
  listByTable() {
    return new Map(this.modelsByTable);
  }

  /**
   * Clear all registered models from the registry.
   */
  clear() {
    this.modelsByTable.clear();
    this.modelsByKey.clear();
  }
}

module.exports = ModelRegistry;
