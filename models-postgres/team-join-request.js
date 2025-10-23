'use strict';

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const { initializeModel } = require('../dal/lib/model-initializer');

let TeamJoinRequest = null;

/**
 * Initialize the PostgreSQL TeamJoinRequest model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeTeamJoinRequestModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping TeamJoinRequest model initialization');
    return null;
  }

  try {
    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      userID: type.string().uuid(4).required(true),
      requestedOn: type.date().default(() => new Date()),
      message: type.string().max(500)
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'team_join_requests',
      schema,
      camelToSnake: {
        teamID: 'team_id',
        userID: 'user_id',
        requestedOn: 'requested_on'
      }
    });
    TeamJoinRequest = model;

    if (!isNew) {
      return TeamJoinRequest;
    }

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
