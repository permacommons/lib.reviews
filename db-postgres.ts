/**
 * PostgreSQL database initialization (ESM)
 *
 * Provides a shared DAL instance for the lib.reviews application while keeping
 * initialization idempotent across production code and tests.
 */

import type { PostgresConfig } from 'config';
import config from 'config';
import createDataAccessLayer, { setDebugLogger, setLanguageProvider } from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/model-types';
import languages from './locales/languages.ts';
import debug from './util/debug.ts';

type JsonObject = Record<string, unknown>;

const PostgresDALFactory = createDataAccessLayer;

setLanguageProvider(languages);
setDebugLogger(debug);

// Set only once the DAL is connected and migrations have run
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
 * Initialize PostgreSQL DAL. Resolves once the DAL is connected and migrations
 * have run; every caller shares the same attempt.
 */
export async function initializePostgreSQL(): Promise<DataAccessLayer> {
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      debug.db('Initializing PostgreSQL DAL...');

      const dalConfig = getPostgresConfig();
      const dal = PostgresDALFactory(
        dalConfig as Partial<PostgresConfig> & JsonObject
      ) as unknown as DataAccessLayer;
      await dal.connect();

      debug.db('PostgreSQL DAL connected successfully');

      try {
        await dal.migrate();
        debug.db('PostgreSQL migrations completed');
      } catch (migrationError) {
        const message =
          migrationError instanceof Error ? migrationError.message : String(migrationError);
        debug.db(`PostgreSQL migration error (may be expected if DB already exists): ${message}`);
      }

      postgresDAL = dal;
      return dal;
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
  return initializePostgreSQL();
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
  if (!connectionPromise) {
    return;
  }

  try {
    // Wait for an attempt that is still in flight; a failed one leaves nothing
    // to close
    const dal = await connectionPromise.catch(() => null);
    if (dal) {
      await dal.disconnect();
      debug.db('PostgreSQL connection closed');
    }
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
