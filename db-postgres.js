'use strict';

/**
 * PostgreSQL database initialization
 * 
 * This module initializes the PostgreSQL DAL as the primary database
 * for the lib.reviews application.
 */

const config = require('config');
const debug = require('./util/debug');
const PostgresDAL = require('./dal');

let postgresDAL = null;
let connectionPromise = null;

/**
 * Initialize PostgreSQL DAL
 */
async function initializePostgreSQL() {
  if (postgresDAL) {
    return postgresDAL;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    try {
      debug.db('Initializing PostgreSQL DAL...');
      
      postgresDAL = PostgresDAL(config.postgres);
      await postgresDAL.connect();
      
      debug.db('PostgreSQL DAL connected successfully');
      
      // Run migrations if needed
      try {
        await postgresDAL.migrate();
        debug.db('PostgreSQL migrations completed');
      } catch (migrationError) {
        debug.db('PostgreSQL migration error (may be expected if DB already exists):', migrationError.message);
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
 * Get the PostgreSQL DAL instance (async)
 */
async function getPostgresDAL() {
  if (!postgresDAL) {
    return await initializePostgreSQL();
  }
  return postgresDAL;
}

/**
 * Get database connection (compatibility method)
 */
async function getDB() {
  return initializePostgreSQL();
}

/**
 * Gracefully close database connection
 */
async function closeConnection() {
  if (postgresDAL) {
    try {
      await postgresDAL.disconnect();
      debug.db('PostgreSQL connection closed');
    } catch (err) {
      debug.error('Error closing PostgreSQL connection:', err);
    }
    postgresDAL = null;
    connectionPromise = null;
  }
}

// Initialize on module load
const dalPromise = initializePostgreSQL();

// Export the DAL instance and compatibility methods
module.exports = {
  initializePostgreSQL,
  getPostgresDAL,
  getDB,
  closeConnection,
  // Provide direct access to the DAL promise for immediate use
  get dal() {
    return postgresDAL;
  },
  // Compatibility method for existing code that expects a promise
  getDAL: () => dalPromise
};