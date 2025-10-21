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
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeTeamSlugModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping TeamSlug model initialization');
    return null;
  }

  try {
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}team_slugs` : 'team_slugs';

    const schema = {
      id: type.string().uuid(4),
      teamID: type.string().uuid(4).required(true),
      slug: type.string().max(255).required(true),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4),
      name: type.string().max(255)
    };

    const { model, isNew } = getOrCreateModel(dal, tableName, schema);

    if (!isNew) {
      if (!customDAL) {
        TeamSlug = model;
      }
      return model;
    }

    model._registerFieldMapping('teamID', 'team_id');
    model._registerFieldMapping('createdOn', 'created_on');
    model._registerFieldMapping('createdBy', 'created_by');

    debug.db('PostgreSQL TeamSlug model initialized (stub)');
    if (!customDAL) {
      TeamSlug = model;
    }
    return model;
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
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresTeamSlugModel(customDAL = null) {
  if (customDAL) {
    return await initializeTeamSlugModel(customDAL);
  }
  
  if (!TeamSlug) {
    TeamSlug = await initializeTeamSlugModel();
  }
  return TeamSlug;
}

module.exports = TeamSlugHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeTeamSlugModel;
module.exports.getPostgresTeamSlugModel = getPostgresTeamSlugModel;
