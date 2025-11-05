import { promises as fs } from 'fs';
import path from 'path';

import { Pool } from 'pg';
import type { PoolClient, PoolConfig, QueryResult } from 'pg';
import type { PostgresConfig } from 'config';

import debug from '../../util/debug.ts';
import Model from './model.ts';
import ModelRegistry from './model-registry.ts';
import type {
  DataAccessLayer as DataAccessLayerContract,
  JsonObject,
  ModelConstructor
} from './model-types.ts';
import type { ModelSchema } from './model.ts';

type PoolLike = Pool | PoolClient;

type DataAccessLayerConfig = (PoolConfig & JsonObject) & Partial<PostgresConfig>;

interface MigrationRow extends JsonObject {
  filename: string;
}

/**
 * Main Data Access Layer class for PostgreSQL
 *
 * Provides connection management, transaction support, and model creation
 * functionality. This class serves as the main interface between the
 * application and the PostgreSQL database.
 */
class DataAccessLayer implements DataAccessLayerContract {
  config: DataAccessLayerConfig;
  pool: Pool | null;
  modelRegistry: ModelRegistry;
  schemaNamespace?: string;
  private _connected: boolean;

  constructor(config: Partial<PostgresConfig> & JsonObject = {}) {
    const defaultConfig: PoolConfig = {
      host: 'localhost',
      port: 5432,
      database: 'libreviews',
      user: 'postgres',
      password: '',
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    };

    this.config = {
      ...defaultConfig,
      ...config
    } as DataAccessLayerConfig;

    this.pool = null;
    this._connected = false;
    this.modelRegistry = new ModelRegistry(this);
  }

  /**
   * Initialize the connection pool and connect to PostgreSQL
   * @returns This instance for chaining
   */
  async connect(): Promise<this> {
    if (this._connected) {
      return this;
    }

    try {
      this.pool = new Pool(this.config as PoolConfig);

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

      this.pool.on('error', (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        debug.error(`PostgreSQL pool error: ${message}`);
        debug.error({ error: err instanceof Error ? err : new Error(message) });
      });

      return this;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Failed to connect to PostgreSQL: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  }

  /**
   * Close all connections and clean up
   */
  async disconnect(): Promise<void> {
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
   * @returns PostgreSQL client connection
   */
  async getConnection(): Promise<PoolClient> {
    if (!this._connected || !this.pool) {
      throw new Error('DAL not connected. Call connect() first.');
    }
    return this.pool.connect();
  }

  /**
   * Execute a query with optional parameters
   * @param text - SQL query text
   * @param params - Query parameters
   * @param client - Optional client connection (for transactions)
   * @returns Query result
   */
  async query<TRecord extends JsonObject = JsonObject>(
    text: string,
    params: unknown[] = [],
    client: PoolLike | null = null
  ): Promise<QueryResult<TRecord>> {
    const queryClient: PoolLike | null = client ?? this.pool;
    if (!queryClient) {
      throw new Error('DAL not connected. Call connect() first.');
    }

    try {
      const start = Date.now();
      const result = await queryClient.query<TRecord>(text, params);
      const duration = Date.now() - start;

      debug.db(`Query executed in ${duration}ms: ${text.substring(0, 100)}...`);
      return result;
    } catch (error) {
      if (typeof error === 'object' && error) {
        (error as JsonObject).query = text;
        (error as JsonObject).parameters = params;
      }
      debug.error(`Query error: ${(error as Error).message}`);
      debug.error(`Query text: ${text}`);
      debug.error(`Query params: ${JSON.stringify(params)}`);
      throw error;
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   * @param callback - Function to execute within transaction
   * @returns Result of the callback function
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
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
      const message = error instanceof Error ? error.message : String(error);
      debug.db(`Transaction rolled back due to error: ${message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a new model class
   * @param name - Model name (table name)
   * @param schema - Model schema definition
   * @param options - Model options
   * @returns Model constructor
   */
  createModel<
    TRecord extends JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(
    name: string,
    schema: ModelSchema<TRecord, TVirtual>,
    options: JsonObject = {}
  ): ModelConstructor<TRecord, TVirtual> {
    const { registryKey, ...modelOptions } = options || {};
    const canonicalKey = typeof registryKey === 'string' ? registryKey : name;

    const existing = this.modelRegistry.get<TRecord, TVirtual>(name)
      || (canonicalKey !== name
        ? this.modelRegistry.get<TRecord, TVirtual>(canonicalKey)
        : null);

    if (existing) {
      throw new Error(`Model '${canonicalKey}' already exists`);
    }

    const ModelClass = Model.createModel<TRecord, TVirtual>(
      name,
      schema,
      modelOptions,
      this
    );
    this.modelRegistry.register(name, ModelClass, { key: canonicalKey });

    debug.db(`Model '${name}' created`);
    return ModelClass;
  }

  /**
   * Get an existing model by name
   * @param name - Model name
   * @returns Model constructor
   */
  getModel<
    TRecord extends JsonObject = JsonObject,
    TVirtual extends JsonObject = JsonObject
  >(name: string): ModelConstructor<TRecord, TVirtual> {
    const model = this.modelRegistry.get<TRecord, TVirtual>(name);
    if (!model) {
      throw new Error(`Model '${name}' not found`);
    }
    return model;
  }

  /**
   * Return a map of registered models keyed by canonical name
   */
  getRegisteredModels(): Map<string, ModelConstructor<JsonObject, JsonObject>> {
    return this.modelRegistry.listByKey();
  }

  /**
   * Expose the registry instance for advanced consumers
   */
  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  /**
   * Run database migrations
   * @param migrationsPath - Path to migration files
   */
  async migrate(migrationsPath = 'migrations'): Promise<void> {
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
      const executedResult = await this.query<MigrationRow>('SELECT filename FROM migrations');
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
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Migration failed: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  }

  /**
   * Rollback the last migration (if supported)
   */
  async rollback(): Promise<void> {
    // For now, rollback is not implemented as it requires down migrations
    // This would be implemented in a future iteration
    throw new Error('Rollback not yet implemented');
  }

  /**
   * Check if the DAL is connected
   */
  isConnected(): boolean {
    return Boolean(this._connected && this.pool && !this.pool.ended);
  }

  /**
   * Get pool statistics
   */
  getPoolStats(): { totalCount: number; idleCount: number; waitingCount: number } | null {
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

export { DataAccessLayer };
export default DataAccessLayer;
