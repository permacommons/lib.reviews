'use strict';

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const { initializeModel } = require('../dal/lib/model-initializer');

let TeamSlug = null;

/**
 * Initialize the PostgreSQL TeamSlug model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeTeamSlugModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping TeamSlug model initialization');
    return null;
  }

  try {
    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      slug: type.string().max(255).required(true),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4),
      name: type.string().max(255)
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'team_slugs',
      schema,
      camelToSnake: {
        teamID: 'team_id',
        createdOn: 'created_on',
        createdBy: 'created_by'
      }
    });

    TeamSlug = model;

    if (!isNew) {
      return TeamSlug;
    }

    debug.db('PostgreSQL TeamSlug model initialized (stub)');
    return TeamSlug;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamSlug model:', error);
    return null;
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const TeamSlugHandle = createAutoModelHandle('team_slugs', initializeTeamSlugModel);

/**
 * Get the PostgreSQL TeamSlug model (initialize if needed)
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function getPostgresTeamSlugModel(dal = null) {
  TeamSlug = await initializeTeamSlugModel(dal);
  return TeamSlug;
}

module.exports = TeamSlugHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeTeamSlugModel;
module.exports.getPostgresTeamSlugModel = getPostgresTeamSlugModel;
