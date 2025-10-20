'use strict';

/**
 * PostgreSQL TeamJoinRequest model implementation
 * 
 * This is the PostgreSQL implementation of the TeamJoinRequest model using the DAL,
 * maintaining compatibility with the existing RethinkDB TeamJoinRequest model interface.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');

let TeamJoinRequest = null;

/**
 * Initialize the PostgreSQL TeamJoinRequest model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeTeamJoinRequestModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping TeamJoinRequest model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}team_join_requests` : 'team_join_requests';
    TeamJoinRequest = dal.createModel(tableName, {
      id: type.string().uuid(4),
      team_id: type.string().uuid(4).required(),
      user_id: type.string().uuid(4).required(),
      request_message: type.string(),
      request_date: type.date().default(() => new Date()),
      rejected_by: type.string().uuid(4),
      rejection_date: type.date(),
      rejection_message: type.string(),
      rejected_until: type.date()
    });

    debug.db('PostgreSQL TeamJoinRequest model initialized');
    return TeamJoinRequest;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamJoinRequest model:', error);
    throw error;
  }
}

/**
 * Get the PostgreSQL TeamJoinRequest model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresTeamJoinRequestModel(customDAL = null) {
  if (!TeamJoinRequest || customDAL) {
    TeamJoinRequest = await initializeTeamJoinRequestModel(customDAL);
  }
  return TeamJoinRequest;
}

module.exports = {
  initializeTeamJoinRequestModel,
  getPostgresTeamJoinRequestModel
};