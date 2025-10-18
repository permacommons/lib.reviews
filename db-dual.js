'use strict';

/**
 * Dual database initialization for RethinkDB and PostgreSQL
 * 
 * This module initializes both databases during the migration period,
 * allowing us to test the PostgreSQL DAL alongside the existing RethinkDB setup.
 */

const config = require('config');
const debug = require('./util/debug');

// RethinkDB (existing)
const rethinkThinky = require('./db');

// PostgreSQL (new DAL)
const PostgresDAL = require('./dal');

let postgresDAL = null;

/**
 * Initialize PostgreSQL DAL if dual database mode is enabled
 */
async function initializePostgreSQL() {
  if (!config.dualDatabaseMode || !config.postgres) {
    debug.db('PostgreSQL DAL not enabled in configuration');
    return null;
  }

  try {
    debug.db('Initializing PostgreSQL DAL...');
    
    postgresDAL = PostgresDAL(config.postgres);
    await postgresDAL.connect();
    
    debug.db('PostgreSQL DAL connected successfully');
    
    // Run migrations
    try {
      await postgresDAL.migrate();
      debug.db('PostgreSQL migrations completed');
    } catch (migrationError) {
      debug.db('PostgreSQL migration error (may be expected if DB already exists):', migrationError.message);
    }
    
    return postgresDAL;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL DAL:', error);
    // Don't throw - allow app to continue with RethinkDB only
    return null;
  }
}

/**
 * Get the PostgreSQL DAL instance
 */
function getPostgresDAL() {
  return postgresDAL;
}

/**
 * Get the RethinkDB Thinky instance
 */
function getRethinkDB() {
  return rethinkThinky;
}

/**
 * Check if dual database mode is enabled
 */
function isDualDatabaseMode() {
  return config.dualDatabaseMode === true;
}

/**
 * Gracefully close both database connections
 */
async function closeConnections() {
  const promises = [];
  
  if (postgresDAL) {
    promises.push(postgresDAL.disconnect().catch(err => 
      debug.error('Error closing PostgreSQL connection:', err)
    ));
  }
  
  // RethinkDB connection cleanup would go here if needed
  // (Thinky handles this automatically)
  
  await Promise.all(promises);
  debug.db('All database connections closed');
}

module.exports = {
  initializePostgreSQL,
  getPostgresDAL,
  getRethinkDB,
  isDualDatabaseMode,
  closeConnections,
  
  // Export the original RethinkDB instance for backward compatibility
  r: rethinkThinky.r,
  type: rethinkThinky.type,
  Errors: rethinkThinky.Errors
};