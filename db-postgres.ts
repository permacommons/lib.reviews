/**
 * PostgreSQL database initialization (ESM)
 *
 * Provides a shared DAL instance for the lib.reviews application while keeping
 * initialization idempotent across production code and tests.
 */

import config from 'config';

import debug from './util/debug.ts';
import createDataAccessLayer from './dal/index.ts';
import type { DataAccessLayer } from './dal/lib/model-types.ts';
import type { PostgresConfig } from 'config';

type JsonObject = Record<string, unknown>;

const PostgresDALFactory = createDataAccessLayer;

let postgresDAL: DataAccessLayer | null = null;
let connectionPromise: Promise<DataAccessLayer> | null = null;

function getPostgresConfig(): PostgresConfig {
  const moduleConfig = config as JsonObject & { postgres?: PostgresConfig };
  if (moduleConfig.postgres) {
    return moduleConfig.postgres;
  }
  if (typeof config.get === 'function') {
    return config.get<PostgresConfig>('postgres');
  }
  throw new Error('PostgreSQL configuration not found.');
}

/**
 * Initialize PostgreSQL DAL.
 */
export async function initializePostgreSQL(): Promise<DataAccessLayer> {
  if (postgresDAL) {
    return postgresDAL;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      debug.db('Initializing PostgreSQL DAL...');

      const dalConfig = getPostgresConfig();
      postgresDAL = PostgresDALFactory(
        dalConfig as Partial<PostgresConfig> & JsonObject
      ) as unknown as DataAccessLayer;
      await postgresDAL.connect();

      debug.db('PostgreSQL DAL connected successfully');

      try {
        await postgresDAL.migrate();
        debug.db('PostgreSQL migrations completed');
      } catch (migrationError) {
        const message =
          migrationError instanceof Error ? migrationError.message : String(migrationError);
        debug.db(`PostgreSQL migration error (may be expected if DB already exists): ${message}`);
      }

      return postgresDAL;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debug.error(`Failed to initialize PostgreSQL DAL: ${message}`);
      debug.error({ error: error instanceof Error ? error : new Error(message) });
      throw error;
    }
  })();

  return connectionPromise;
}

/**
 * Get the PostgreSQL DAL instance (async).
 */
export async function getPostgresDAL(): Promise<DataAccessLayer> {
  if (!postgresDAL) {
    return initializePostgreSQL();
  }
  return postgresDAL;
}

/**
 * Compatibility method for legacy callers.
 */
export async function getDB(): Promise<DataAccessLayer> {
  return initializePostgreSQL();
}

/**
 * Gracefully close database connection.
 */
export async function closeConnection(): Promise<void> {
  if (!postgresDAL) {
    return;
  }

  try {
    await postgresDAL.disconnect();
    debug.db('PostgreSQL connection closed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug.error(`Error closing PostgreSQL connection: ${message}`);
    debug.error({ error: err instanceof Error ? err : new Error(message) });
  }

  postgresDAL = null;
  connectionPromise = null;
}

const dalPromise = initializePostgreSQL();

export function getDAL(): Promise<DataAccessLayer> {
  return dalPromise;
}

const dbPostgres = {
  initializePostgreSQL,
  getPostgresDAL,
  getDB,
  closeConnection,
  getDAL,
};

Object.defineProperty(dbPostgres, 'dal', {
  enumerable: true,
  get() {
    return postgresDAL;
  },
});

export default dbPostgres;
