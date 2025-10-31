/**
 * PostgreSQL database initialization (ESM)
 *
 * Provides a shared DAL instance for the lib.reviews application while keeping
 * initialization idempotent across production code and tests.
 */

import config from 'config';
import debug from './util/debug.mjs';
import PostgresDALModule from './dal/index.js';

const PostgresDALFactory = typeof PostgresDALModule === 'function'
  ? PostgresDALModule
  : PostgresDALModule?.default;

if (typeof PostgresDALFactory !== 'function') {
  throw new TypeError('Postgres DAL factory not found. Ensure ./dal/index.js exports a constructor.');
}

let postgresDAL = null;
let connectionPromise = null;

function getPostgresConfig() {
  if (config?.postgres) {
    return config.postgres;
  }
  if (typeof config.get === 'function') {
    return config.get('postgres');
  }
  throw new Error('PostgreSQL configuration not found.');
}

/**
 * Initialize PostgreSQL DAL.
 */
export async function initializePostgreSQL() {
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
      postgresDAL = PostgresDALFactory(dalConfig);
      await postgresDAL.connect();

      debug.db('PostgreSQL DAL connected successfully');

      try {
        await postgresDAL.migrate();
        debug.db('PostgreSQL migrations completed');
      } catch (migrationError) {
        debug.db(
          'PostgreSQL migration error (may be expected if DB already exists):',
          migrationError.message
        );
      }

      return postgresDAL;
    } catch (error) {
      debug.error('Failed to initialize PostgreSQL DAL:', error);
      throw error;
    }
  })();

  return connectionPromise;
}

/**
 * Get the PostgreSQL DAL instance (async).
 */
export async function getPostgresDAL() {
  if (!postgresDAL) {
    return initializePostgreSQL();
  }
  return postgresDAL;
}

/**
 * Compatibility method for legacy callers.
 */
export async function getDB() {
  return initializePostgreSQL();
}

/**
 * Gracefully close database connection.
 */
export async function closeConnection() {
  if (!postgresDAL) {
    return;
  }

  try {
    await postgresDAL.disconnect();
    debug.db('PostgreSQL connection closed');
  } catch (err) {
    debug.error('Error closing PostgreSQL connection:', err);
  }

  postgresDAL = null;
  connectionPromise = null;
}

const dalPromise = initializePostgreSQL();

export function getDAL() {
  return dalPromise;
}

const dbPostgres = {
  initializePostgreSQL,
  getPostgresDAL,
  getDB,
  closeConnection,
  getDAL
};

Object.defineProperty(dbPostgres, 'dal', {
  enumerable: true,
  get() {
    return postgresDAL;
  }
});

export default dbPostgres;
