'use strict';

/**
 * PostgreSQL ThingSlug model implementation (stub)
 * 
 * This is a minimal stub implementation for the ThingSlug model.
 * Full implementation will be added as needed.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const { getOrCreateModel } = require('../dal/lib/model-factory');

let ThingSlug = null;

/**
 * Initialize the PostgreSQL ThingSlug model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeThingSlugModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping ThingSlug model initialization');
    return null;
  }

  try {
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}thing_slugs` : 'thing_slugs';

    const schema = {
      id: type.string().uuid(4),
      thingID: type.string().uuid(4).required(true),
      slug: type.string().max(255).required(true),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4),
      baseName: type.string().max(255),
      name: type.string().max(255),
      qualifierPart: type.string().max(255)
    };

    const { model, isNew } = getOrCreateModel(dal, tableName, schema);

    if (!isNew) {
      if (!customDAL) {
        ThingSlug = model;
      }
      return model;
    }

    model._registerFieldMapping('thingID', 'thing_id');
    model._registerFieldMapping('createdOn', 'created_on');
    model._registerFieldMapping('createdBy', 'created_by');
    model._registerFieldMapping('baseName', 'base_name');
    model._registerFieldMapping('qualifierPart', 'qualifier_part');

    debug.db('PostgreSQL ThingSlug model initialized (stub)');
    if (!customDAL) {
      ThingSlug = model;
    }
    return model;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL ThingSlug model:', error);
    return null;
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const ThingSlugHandle = createAutoModelHandle('thing_slugs', initializeThingSlugModel);

/**
 * Get the PostgreSQL ThingSlug model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresThingSlugModel(customDAL = null) {
  if (customDAL) {
    return await initializeThingSlugModel(customDAL);
  }
  
  if (!ThingSlug) {
    ThingSlug = await initializeThingSlugModel();
  }
  return ThingSlug;
}

module.exports = ThingSlugHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeThingSlugModel;
module.exports.getPostgresThingSlugModel = getPostgresThingSlugModel;
