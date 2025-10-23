'use strict';

/**
 * Main Data Access Layer class for PostgreSQL
 * 
 * Provides connection management, transaction support, and model creation
 * functionality. This class serves as the main interface between the
 * application and the PostgreSQL database.
 */

const { Pool } = require('pg');
const Model = require('./model');
const QueryBuilder = require('./query-builder');
const debug = require('../../util/debug');
const fs = require('fs').promises;
const path = require('path');
const ModelRegistry = require('./model-registry');

class DataAccessLayer {
  constructor(config = {}) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'libreviews',
      user: config.user || 'postgres',
      password: config.password || '',
      max: config.max || 20, // Maximum number of connections in pool
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
      ...config
    };
    
    this.pool = null;
    this._connected = false;
    this.modelRegistry = new ModelRegistry(this);
  }

  /**
   * Initialize the connection pool and connect to PostgreSQL
   * @returns {Promise<DataAccessLayer>} This instance for chaining
   */
  async connect() {
    if (this._connected) {
      return this;
    }

    try {
      this.pool = new Pool(this.config);
      
      // Test the connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      
      this._connected = true;
      debug.db('PostgreSQL connection pool established');
      
      // Set up pool event handlers
      this.pool.on('connect', () => {
        debug.db('New PostgreSQL client connected');
      });
      
      this.pool.on('error', (err) => {
        debug.error('PostgreSQL pool error:', err);
      });
      
      return this;
    } catch (error) {
      debug.error('Failed to connect to PostgreSQL:', error);
      throw error;
    }
  }

  /**
   * Close all connections and clean up
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this._connected = false;
      this.modelRegistry.clear();
      debug.db('PostgreSQL connection pool closed');
    }
  }

  /**
   * Get a connection from the pool
   * @returns {Promise<Object>} PostgreSQL client connection
   */
  async getConnection() {
    if (!this._connected) {
      throw new Error('DAL not connected. Call connect() first.');
    }
    return await this.pool.connect();
  }

  /**
   * Execute a query with optional parameters
   * @param {string} text - SQL query text
   * @param {Array} params - Query parameters
   * @param {Object} client - Optional client connection (for transactions)
   * @returns {Promise<Object>} Query result
   */
  async query(text, params = [], client = null) {
    const queryClient = client || this.pool;
    
    try {
      const start = Date.now();
      const result = await queryClient.query(text, params);
      const duration = Date.now() - start;
      
      debug.db(`Query executed in ${duration}ms: ${text.substring(0, 100)}...`);
      return result;
    } catch (error) {
      debug.error('Query error:', error);
      debug.error('Query text:', text);
      debug.error('Query params:', params);
      throw error;
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   * @param {Function} callback - Function to execute within transaction
   * @returns {Promise<*>} Result of the callback function
   */
  async transaction(callback) {
    const client = await this.getConnection();
    
    try {
      await client.query('BEGIN');
      debug.db('Transaction started');
      
      const result = await callback(client);
      
      await client.query('COMMIT');
      debug.db('Transaction committed');
      
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      debug.db('Transaction rolled back due to error:', error.message);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a new model class
   * @param {string} name - Model name (table name)
   * @param {Object} schema - Model schema definition
   * @param {Object} options - Model options
   * @returns {Function} Model constructor
   */
  createModel(name, schema, options = {}) {
    const { registryKey, ...modelOptions } = options || {};
    const canonicalKey = registryKey || name;

    const existing = this.modelRegistry.get(name) ||
      (canonicalKey !== name ? this.modelRegistry.get(canonicalKey) : null);

    if (existing) {
      throw new Error(`Model '${canonicalKey}' already exists`);
    }

    const ModelClass = Model.createModel(name, schema, modelOptions, this);
    this.modelRegistry.register(name, ModelClass, { key: canonicalKey });

    debug.db(`Model '${name}' created`);
    return ModelClass;
  }

  /**
   * Get an existing model by name
   * @param {string} name - Model name
   * @returns {Function} Model constructor
   */
  getModel(name) {
    const model = this.modelRegistry.get(name);
    if (!model) {
      throw new Error(`Model '${name}' not found`);
    }
    return model;
  }

  /**
   * Return a map of registered models keyed by canonical name
   * @returns {Map<string, Function>}
   */
  getRegisteredModels() {
    return this.modelRegistry.listByKey();
  }

  /**
   * Expose the registry instance for advanced consumers
   * @returns {ModelRegistry}
   */
  getModelRegistry() {
    return this.modelRegistry;
  }

  /**
   * Run database migrations
   * @param {string} migrationsPath - Path to migration files
   * @returns {Promise<void>}
   */
  async migrate(migrationsPath = 'migrations') {
    debug.db('Running database migrations...');
    
    try {
      // Create migrations table if it doesn't exist
      await this.query(`
        CREATE TABLE IF NOT EXISTS migrations (
          id SERIAL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL UNIQUE,
          executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `);

      // Get list of migration files
      const migrationFiles = await fs.readdir(migrationsPath);
      const sqlFiles = migrationFiles
        .filter(file => file.endsWith('.sql'))
        .sort();

      // Get already executed migrations
      const executedResult = await this.query('SELECT filename FROM migrations');
      const executedMigrations = new Set(executedResult.rows.map(row => row.filename));

      // Execute pending migrations
      for (const filename of sqlFiles) {
        if (!executedMigrations.has(filename)) {
          debug.db(`Executing migration: ${filename}`);
          
          const migrationPath = path.join(migrationsPath, filename);
          const migrationSQL = await fs.readFile(migrationPath, 'utf8');
          
          await this.transaction(async (client) => {
            // Execute the migration
            await client.query(migrationSQL);
            
            // Record the migration as executed
            await client.query(
              'INSERT INTO migrations (filename) VALUES ($1)',
              [filename]
            );
          });
          
          debug.db(`Migration completed: ${filename}`);
        }
      }
      
      debug.db('All migrations completed');
    } catch (error) {
      debug.error('Migration failed:', error);
      throw error;
    }
  }

  /**
   * Rollback the last migration (if supported)
   * @returns {Promise<void>}
   */
  async rollback() {
    // For now, rollback is not implemented as it requires down migrations
    // This would be implemented in a future iteration
    throw new Error('Rollback not yet implemented');
  }

  /**
   * Check if the DAL is connected
   * @returns {boolean} Connection status
   */
  isConnected() {
    return this._connected && this.pool && !this.pool.ended;
  }

  /**
   * Get pool statistics
   * @returns {Object} Pool statistics
   */
  getPoolStats() {
    if (!this.pool) {
      return null;
    }
    
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount
    };
  }
}

module.exports = DataAccessLayer;