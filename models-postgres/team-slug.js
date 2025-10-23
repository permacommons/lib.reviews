'use strict';

/**
 * PostgreSQL TeamSlug model implementation (stub)
 * 
 * This is a minimal stub implementation for the TeamSlug model.
 * Full implementation will be added as needed.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const { getOrCreateModel } = require('../dal/lib/model-factory');

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
    const tableName = activeDAL.tablePrefix ? `${activeDAL.tablePrefix}team_slugs` : 'team_slugs';

    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      slug: type.string().max(255).required(true),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4),
      name: type.string().max(255)
    };

    const { model, isNew } = getOrCreateModel(activeDAL, tableName, schema, {
      registryKey: 'team_slugs'
    });

    TeamSlug = model;

    if (!isNew) {
      return TeamSlug;
    }

    model._registerFieldMapping('teamID', 'team_id');
    model._registerFieldMapping('createdOn', 'created_on');
    model._registerFieldMapping('createdBy', 'created_by');

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
