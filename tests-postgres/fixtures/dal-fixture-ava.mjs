import { createRequire } from 'module';
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
    this.dal = null;
    this.models = {};
    this.loaded = false;
    this.testInstance = testInstance;
    this.tablePrefix = `test_${this.namespace}_`;
    this.connected = false;
    this.bootstrapError = null;
    this.skipReason = null;
  }

  /**
   * Bootstrap the DAL with PostgreSQL connection and models
   * Uses NODE_APP_INSTANCE to determine which test database to connect to
   * @param {Array} modelDefinitions - Array of model definitions to create
   */
  async bootstrap(modelDefinitions = []) {
    this.bootstrapError = null;
    this.skipReason = null;

    // Ensure we have the right test instance
    if (!process.env.NODE_APP_INSTANCE) {
      process.env.NODE_APP_INSTANCE = this.testInstance;
    }

    logNotice(`Loading PostgreSQL DAL configuration for AVA instance ${this.testInstance}.`);
    
    // Load config
    const config = require('config');
    
    // Check if postgres config exists
    if (!config.has('postgres')) {
      const message = `PostgreSQL configuration not found for instance ${this.testInstance}.`;
      this.bootstrapError = new Error(message);
      this.skipReason = message;
      logNotice(`${message} Skipping PostgreSQL-dependent tests.`);
      return;
    }
    
    const pgConfig = {
      ...config.get('postgres'),
      allowExitOnIdle: true
    };
    
    // Import DAL components
    const DataAccessLayer = require('../../dal/lib/data-access-layer');
    const revision = require('../../dal/lib/revision');
    const Type = require('../../dal/lib/type');
    
    logNotice('Connecting to PostgreSQL for AVA tests.');
    
    // Initialize DAL
    this.dal = new DataAccessLayer(pgConfig);
    // Attach table prefix so real models can derive their table names
    this.dal.tablePrefix = this.tablePrefix;
    try {
      await this.dal.connect();
      this.connected = true;
      logOK('PostgreSQL DAL connected for AVA tests.');
    } catch (error) {
      // Best effort cleanup of partially initialized pools
      try {
        await this.dal.disconnect();
      } catch (disconnectError) {
        logNotice(`Ignoring disconnect error during bootstrap cleanup: ${disconnectError.message}`);
      }
      this.dal = null;
      this.connected = false;
      this.bootstrapError = error;
      this.skipReason = error.message || 'Failed to connect to PostgreSQL';
      logNotice(`PostgreSQL connection unavailable for AVA tests: ${this.skipReason}`);
      return;
    }
    
    // Create models if provided
    if (modelDefinitions.length > 0) {
      logNotice('Creating DAL models for AVA tests.');
      
      for (const modelDef of modelDefinitions) {
        // Use prefixed table names to avoid conflicts
        const tableName = this.tablePrefix + modelDef.name;
        const model = this.dal.createModel(tableName, modelDef.schema, modelDef.options);
        
        // Add revision handlers if the model has revision fields
        if (modelDef.hasRevisions) {
          model.createFirstRevision = revision.getFirstRevisionHandler(model);
          model.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(model);
          model.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(model);
          model.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(model);
          
          // Add instance methods
          model.define('newRevision', revision.getNewRevisionHandler(model));
          model.define('deleteAllRevisions', revision.getDeleteAllRevisionsHandler(model));
        }
        
        this.models[modelDef.name] = model;
      }
      
      logOK(`Created ${modelDefinitions.length} DAL models for AVA tests.`);
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
    
    // Use a transaction to ensure cleanup is atomic
    await this.dal.transaction(async (client) => {
      for (const tableName of tableNames) {
        const fullTableName = this.tablePrefix + tableName;
        try {
          await client.query(`DELETE FROM ${fullTableName}`);
        } catch (error) {
          // Table might not exist, which is fine
          if (!error.message.includes('does not exist')) {
            console.warn(`Warning: Failed to clean table ${fullTableName}:`, error.message);
          }
        }
      }
    });
  }

  /**
   * Create test tables for models with proper prefixing
   * @param {Array} tableDefinitions - Array of table creation definitions
   */
  async createTestTables(tableDefinitions = []) {
    if (!this.dal || !this.connected) return;
    
    for (const tableDef of tableDefinitions) {
      const fullTableName = this.tablePrefix + tableDef.name;
      try {
        // Replace table name in SQL
        const sql = tableDef.sql.replace(
          new RegExp(`\\b${tableDef.name}\\b`, 'g'), 
          fullTableName
        );
        await this.dal.query(sql);
        
        if (tableDef.indexes) {
          for (const indexSql of tableDef.indexes) {
            // Replace table name and index name in index SQL
            const prefixedIndexSql = indexSql
              .replace(new RegExp(`\\b${tableDef.name}\\b`, 'g'), fullTableName)
              .replace(/idx_([a-zA-Z0-9_]+)/g, `idx_${this.namespace}_$1`);
            await this.dal.query(prefixedIndexSql);
          }
        }
      } catch (error) {
        // Ignore "already exists" errors
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
  async cleanup() {
    const targetHost = this.dal?.config?.host || 'localhost';
    const targetPort = this.dal?.config?.port || 5432;
    if (this.dal) {
      logNotice('Cleaning up PostgreSQL DAL for AVA tests.');
      try {
        await this.dal.disconnect();
        logOK('PostgreSQL DAL disconnected for AVA tests.');
      } catch (error) {
        console.error('Failed to disconnect DAL:', error);
      }
      this.dal = null;
    }
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
    } catch {}
    this.connected = false;
    this.models = {};
    this.loaded = false;
    this.bootstrapError = null;
    this.skipReason = null;

    try {
      const pg = require('pg');
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
        const sockets = getActiveHandles().filter(handle => {
          if (handle?.constructor?.name !== 'Socket') return false;
          const remotePort = handle.remotePort;
          const remoteAddress = handle.remoteAddress;
          return remotePort === targetPort &&
            (!remoteAddress || remoteAddress === '127.0.0.1' || remoteAddress === targetHost || remoteAddress === '::1');
        });
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
    return this.models[name];
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
  async initializeModels(loaders = []) {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }

    const results = {};

    for (const entry of loaders) {
      if (!entry) continue;

      let loaderFn;
      let key;

      if (typeof entry === 'function') {
        loaderFn = entry;
      } else if (typeof entry === 'object') {
        loaderFn = entry.loader || entry.load;
        key = entry.key || entry.name;
      }

      if (typeof loaderFn !== 'function') {
        continue;
      }

      const model = await loaderFn(this.dal);
      if (!model) continue;

      const tableName = typeof model.tableName === 'string' ? model.tableName : '';
      const baseName = tableName.startsWith(this.tablePrefix) ?
        tableName.slice(this.tablePrefix.length) :
        tableName;

      const modelKey = key || baseName || loaderFn.name || `model_${Object.keys(results).length + 1}`;
      this.models[modelKey] = model;
      results[modelKey] = model;
    }

    return results;
  }
}

export const createDALFixtureAVA = (testInstance = 'testing-2', options = {}) =>
  new DALFixtureAVA(testInstance, options);
