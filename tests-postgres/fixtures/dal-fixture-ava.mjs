import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { logNotice, logOK } from '../helpers/test-helpers.mjs';

const require = createRequire(import.meta.url);

/**
 * AVA-compatible PostgreSQL DAL fixture for testing
 * 
 * Designed to work with AVA's concurrency model (concurrency: 4) by:
 * - Using separate test databases (libreviews_test_1, libreviews_test_2, etc.)
 * - Prefixing table names to avoid conflicts between concurrent tests
 * - Providing proper cleanup and connection management
 * - Supporting test isolation with atomic transactions
 */
const sanitizeIdentifier = value => {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

class DALFixtureAVA {
  constructor(testInstance = 'testing-2', options = {}) {
    const { tableSuffix } = options;
    const instanceKey = sanitizeIdentifier(testInstance) || 'testing_2';
    const suffixKey = sanitizeIdentifier(tableSuffix);
    this.instanceKey = instanceKey;
    this.namespace = suffixKey ? `${instanceKey}_${suffixKey}` : instanceKey;
    this.schemaName = `test_${this.namespace}`;
    this.dal = null;
    this.harness = null;
    this.models = {};
    this.customModels = new Map();
    this.userModel = null;
    this.loaded = false;
    this.testInstance = testInstance;
    this.tablePrefix = `${this.schemaName}.`;
    this.connected = false;
    this.bootstrapError = null;
    this.skipReason = null;
    this.managedTables = [];
  }

  /**
   * Bootstrap the DAL with PostgreSQL connection and models
   * Uses NODE_APP_INSTANCE to determine which test database to connect to
   * @param {Object|Array} [options] - Bootstrap options or legacy model definitions array
   */
  async bootstrap(options = []) {
    this.bootstrapError = null;
    this.skipReason = null;

    const legacyModelDefs = Array.isArray(options) ? options : null;
    const normalizedOptions =
      options && !Array.isArray(options) ? { ...options } : {};
    if (legacyModelDefs) {
      normalizedOptions.modelDefs = legacyModelDefs;
    }

    const envDefaults = {
      NODE_ENV: 'development',
      NODE_CONFIG_DISABLE_WATCH: 'Y',
      LIBREVIEWS_SKIP_RETHINK: '1',
      NODE_APP_INSTANCE: this.testInstance
    };

    const envConfig = { ...envDefaults, ...(normalizedOptions.env || {}) };

    for (const [key, value] of Object.entries(envConfig)) {
      if (value === undefined) continue;
      process.env[key] = value;
    }

    logNotice(`Loading PostgreSQL DAL configuration for AVA instance ${this.testInstance}.`);

    let harness;
    try {
      const { createTestHarness } = require('../../bootstrap/dal');
      harness = await createTestHarness({
        schemaName: this.schemaName,
        tablePrefix: this.tablePrefix,
        registerModels: true
      });
    } catch (error) {
      this.bootstrapError = error;
      this.skipReason = error.message || 'Failed to initialize PostgreSQL harness';
      logNotice(`PostgreSQL connection unavailable for AVA tests: ${this.skipReason}`);
      return;
    }

    this.harness = harness;
    this.dal = harness.dal;
    this.tablePrefix = harness.tablePrefix || this.tablePrefix;
    this.connected = true;
    this.models = Object.fromEntries(harness.registeredModels);
    this.customModels = new Map();

    logOK('PostgreSQL DAL connected for AVA tests.');

    const modelDefinitions = Array.isArray(normalizedOptions.modelDefs)
      ? normalizedOptions.modelDefs
      : [];

    if (modelDefinitions.length > 0) {
      const revision = require('../../dal/lib/revision');
      const { getOrCreateModel } = require('../../dal/lib/model-factory');

      logNotice('Creating DAL models for AVA tests.');

      for (const modelDef of modelDefinitions) {
        const tableName = `${this.tablePrefix}${modelDef.name}`;
        const { model } = getOrCreateModel(this.dal, tableName, modelDef.schema, {
          registryKey: modelDef.name
        });

        if (modelDef.hasRevisions) {
          model.createFirstRevision = revision.getFirstRevisionHandler(model);
          model.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(model);
          model.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(model);
          model.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(model);
          model.define('newRevision', revision.getNewRevisionHandler(model));
          model.define('deleteAllRevisions', revision.getDeleteAllRevisionsHandler(model));
        }

        this.customModels.set(modelDef.name, model);
        this.models[modelDef.name] = model;
      }

      logOK(`Created ${modelDefinitions.length} DAL models for AVA tests.`);
    }

    const tableDefinitions = normalizedOptions.tableDefs;
    if (Array.isArray(tableDefinitions) && tableDefinitions.length > 0) {
      await this.createTestTables(tableDefinitions);
      const managed = tableDefinitions
        .map(def => def?.name)
        .filter(Boolean);
      if (managed.length > 0) {
        const unique = new Set([...this.managedTables, ...managed]);
        this.managedTables = Array.from(unique);
      }
    }

    this.loaded = true;
    logOK('AVA DAL fixture ready. 🚀');
  }

  /**
   * Clean up test tables and data with proper isolation
   * Uses transactions to ensure atomic cleanup between tests
   * @param {Array} tableNames - Names of tables to clean up (without prefix)
   */
  async cleanupTables(tableNames = []) {
    if (!this.dal || !this.connected) return;
    
    if (!Array.isArray(tableNames) || tableNames.length === 0) return;

    const qualifiedTables = tableNames.map(name => `${this.tablePrefix}${name}`);
    try {
      await this.dal.query(
        `TRUNCATE ${qualifiedTables.join(', ')} RESTART IDENTITY CASCADE`
      );
    } catch (error) {
      console.warn(`Warning: Failed to truncate tables ${qualifiedTables.join(', ')}:`, error.message);
    }
  }

  /**
   * Create test tables for models with proper prefixing
   * @param {Array} tableDefinitions - Array of table creation definitions
   */
  async createTestTables(tableDefinitions = []) {
    if (!this.dal || !this.connected) return;
    if (!Array.isArray(tableDefinitions) || tableDefinitions.length === 0) return;

    for (const tableDef of tableDefinitions) {
      const baseName = tableDef.name;
      const fullTableName = `${this.tablePrefix}${baseName}`;
      try {
        const tableRegex = new RegExp(`\\b${baseName}\\b`, 'g');
        const createSql = tableDef.sql.replace(tableRegex, fullTableName);
        await this.dal.query(createSql);

        if (tableDef.indexes) {
          for (const indexSql of tableDef.indexes) {
            const prefixedIndexSql = indexSql
              .replace(tableRegex, fullTableName)
              .replace(/idx_([a-zA-Z0-9_]+)/g, `idx_${this.namespace}_$1`);
            await this.dal.query(prefixedIndexSql);
          }
        }
      } catch (error) {
        if (!error.message.includes('already exists')) {
          throw error;
        }
      }
    }
  }

  /**
   * Drop test tables with proper prefixing
   * @param {Array} tableNames - Names of tables to drop (without prefix)
   */
  async dropTestTables(tableNames = []) {
    if (!this.dal || !this.connected) return;
    
    for (const tableName of tableNames) {
      const fullTableName = this.tablePrefix + tableName;
      try {
        await this.dal.query(`DROP TABLE IF EXISTS ${fullTableName} CASCADE`);
      } catch (error) {
        console.warn(`Warning: Failed to drop table ${fullTableName}:`, error.message);
      }
    }
  }

  /**
   * Clean up the DAL fixture
   */
  async cleanup(options = {}) {
    logNotice('Cleaning up PostgreSQL DAL for AVA tests.');

    if (this.dal && this.connected && this.managedTables.length > 0) {
      const shouldDrop = options.dropTables !== false;
      if (shouldDrop) {
        const toDrop = [...this.managedTables].reverse();
        await this.dropTestTables(toDrop);
        this.managedTables = [];
      }
    }

    if (this.harness) {
      try {
        await this.harness.cleanup(options);
        logOK('PostgreSQL DAL disconnected for AVA tests.');
      } catch (error) {
        console.error('Failed to disconnect DAL harness:', error);
      }
    }

    this.harness = null;
    this.dal = null;
    this.connected = false;
    this.models = {};
    this.customModels = new Map();
    this.userModel = null;
    this.loaded = false;
    this.bootstrapError = null;
    this.skipReason = null;

    try {
      const pg = require('pg');
      if (pg?.pools?.all) {
        await Promise.all(Array.from(pg.pools.all).map(async ([, pool]) => {
          try {
            await pool.end();
          } catch {}
        }));
        pg.pools.all.clear?.();
      }
      if (pg && pg._pools && typeof pg._pools.forEach === 'function') {
        for (const pool of pg._pools) {
          try {
            await pool.end();
          } catch {}
        }
        if (typeof pg._pools.clear === 'function') {
          pg._pools.clear();
        }
      }
      if (typeof pg.end === 'function') {
        await pg.end().catch(() => {});
      }
    } catch {}

    const getActiveHandles = process._getActiveHandles?.bind(process);
    if (typeof getActiveHandles === 'function') {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const sockets = getActiveHandles().filter(handle => handle?.constructor?.name === 'Socket');
        if (sockets.length === 0) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  /**
   * Get a model by name
   * @param {string} name - Model name (without prefix)
   * @returns {Object} Model class
   */
  getModel(name) {
    if (this.customModels.has(name)) {
      return this.customModels.get(name);
    }

    if (this.models[name]) {
      return this.models[name];
    }

    if (!this.dal || !this.connected) {
      return undefined;
    }

    try {
      const model = this.dal.getModel(name);
      if (model) {
        this.models[name] = model;
      }
      return model;
    } catch (error) {
      const notFound = /Model '.*' not found/.test(error?.message || '');
      if (notFound) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Execute a raw query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise} Query result
   */
  async query(sql, params = []) {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }
    return await this.dal.query(sql, params);
  }

  /**
   * Get the full table name with prefix
   * @param {string} tableName - Base table name
   * @returns {string} Full table name with prefix
   */
  getTableName(tableName) {
    return this.tablePrefix + tableName;
  }

  /**
   * Create a barebones test user directly in the schema
   * @param {string} namePrefix
   * @returns {{id: string, is_super_user: boolean, is_trusted: boolean}}
   */
  async createTestUser(namePrefix = 'Test User') {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }

    if (!this.userModel) {
      this.userModel = this.getModel('users');
      if (!this.userModel) {
        throw new Error('Unable to access user model');
      }
    }

    const uuid = randomUUID();
    const name = `${namePrefix} ${uuid.slice(0, 8)}`;

    const user = await this.userModel.create({
      name,
      password: 'secret123',
      email: `${uuid}@example.com`
    });

    return {
      id: user.id,
      actor: {
        id: user.id,
        is_super_user: false,
        is_trusted: true
      }
    };
  }

  /**
   * Return true if the fixture has an active PostgreSQL connection
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Retrieve the reason why bootstrap skipped connecting
   * @returns {string|null}
   */
  getSkipReason() {
    return this.skipReason;
  }

  /**
   * Initialize real PostgreSQL models using their initializer functions.
   * Each initializer receives the DAL instance so it can attach to the same
   * connection pool and honor table prefixes for isolation.
   * @param {Array} loaders - Array of loader configs or functions
   * @returns {Object} Map of loaded models keyed by base table name
   */
  async initializeModels(descriptors = []) {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }

    const results = {};

    for (const entry of descriptors) {
      if (!entry) continue;

      let key;
      let alias;

      if (typeof entry === 'string') {
        key = entry;
        alias = entry;
      } else if (typeof entry === 'object') {
        key = entry.key || entry.name || entry.table || entry.identifier;
        alias = entry.alias || entry.as || entry.key || entry.name;
      }

      if (!key) {
        continue;
      }

      const model = this.getModel(key);
      if (!model) {
        continue;
      }

      const aliasKey = alias || key;
      this.models[aliasKey] = model;
      results[aliasKey] = model;
    }

    return results;
  }
}

export const createDALFixtureAVA = (testInstance = 'testing-2', options = {}) =>
  new DALFixtureAVA(testInstance, options);
