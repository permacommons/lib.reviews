'use strict';

/**
 * PostgreSQL TeamJoinRequest model implementation (stub)
 * 
 * This is a minimal stub implementation for the TeamJoinRequest model.
 * Full implementation will be added as needed.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const { getOrCreateModel } = require('../dal/lib/model-factory');

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
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}team_join_requests` : 'team_join_requests';
    
    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      userID: type.string().uuid(4).required(true),
      requestedOn: type.date().default(() => new Date()),
      message: type.string().max(500)
    };

    const { model, isNew } = getOrCreateModel(dal, tableName, schema);
    TeamJoinRequest = model;

    if (!isNew) {
      return TeamJoinRequest;
    }

    TeamJoinRequest._registerFieldMapping('teamID', 'team_id');
    TeamJoinRequest._registerFieldMapping('userID', 'user_id');
    TeamJoinRequest._registerFieldMapping('requestedOn', 'requested_on');

    debug.db('PostgreSQL TeamJoinRequest model initialized (stub)');
    return TeamJoinRequest;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamJoinRequest model:', error);
    return null;
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const TeamJoinRequestHandle = createAutoModelHandle('team_join_requests', initializeTeamJoinRequestModel);

module.exports = TeamJoinRequestHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeTeamJoinRequestModel;
