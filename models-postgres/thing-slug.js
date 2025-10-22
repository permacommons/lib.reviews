'use strict';

/**
 * PostgreSQL ThingSlug model implementation (stub)
 * 
 * This is a minimal stub implementation for the ThingSlug model.
 * Full implementation will be added as needed.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const { ConstraintError } = require('../dal/lib/errors');
const { getOrCreateModel } = require('../dal/lib/model-factory');

let ThingSlug = null;

// Reserved slugs that must never be used without qualification
const reservedSlugs = [
  'register', 'actions', 'signin', 'login', 'teams', 'user', 'new',
  'signout', 'logout', 'api', 'faq', 'static', 'terms'
];

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

    const { model } = getOrCreateModel(dal, tableName, schema);

    model._registerFieldMapping('thingID', 'thing_id');
    model._registerFieldMapping('createdOn', 'created_on');
    model._registerFieldMapping('createdBy', 'created_by');
    model._registerFieldMapping('baseName', 'base_name');
    model._registerFieldMapping('qualifierPart', 'qualifier_part');
    model.define('qualifiedSave', qualifiedSave);
    model.reservedSlugs = reservedSlugs;

    debug.db('PostgreSQL ThingSlug model initialized');
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
ThingSlugHandle.reservedSlugs = reservedSlugs;

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

async function qualifiedSave() {
  const Model = this.constructor;
  const dal = Model.dal;

  if (!dal) {
    throw new Error('ThingSlug DAL not initialized');
  }

  if (!this.baseName) {
    this.baseName = this.name;
  }

  if (!this.createdOn) {
    this.createdOn = new Date();
  }

  const baseName = this.baseName;
  const thingID = this.thingID;
  const forceQualifier = reservedSlugs.includes((this.name || '').toLowerCase());

  const findByName = async name => {
    const existing = await dal.query(
      `SELECT * FROM ${Model.tableName} WHERE name = $1 LIMIT 1`,
      [name]
    );
    return existing.rows.length ? Model._createInstance(existing.rows[0]) : null;
  };

  const attemptSave = async () => {
    try {
      await this.save();
      return this;
    } catch (error) {
      if (error instanceof ConstraintError) {
        return null;
      }
      throw error;
    }
  };

  if (!forceQualifier) {
    const saved = await attemptSave();
    if (saved) {
      return saved;
    }
    const existing = await findByName(this.name);
    if (existing && existing.thingID === thingID) {
      return existing;
    }
  }

  const reuseQuery = `
    SELECT *
    FROM ${Model.tableName}
    WHERE base_name = $1
      AND thing_id = $2
    ORDER BY created_on DESC
    LIMIT 1
  `;
  let result = await dal.query(reuseQuery, [baseName, thingID]);
  if (result.rows.length) {
    return Model._createInstance(result.rows[0]);
  }

  const latestQuery = `
    SELECT qualifier_part
    FROM ${Model.tableName}
    WHERE base_name = $1
    ORDER BY created_on DESC
    LIMIT 1
  `;
  result = await dal.query(latestQuery, [baseName]);
  let nextQualifier = '2';
  if (result.rows.length && result.rows[0].qualifier_part) {
    const parsed = parseInt(result.rows[0].qualifier_part, 10);
    if (!Number.isNaN(parsed)) {
      nextQualifier = String(parsed + 1);
    }
  }

  while (true) {
    this.name = `${baseName}-${nextQualifier}`;
    this.slug = this.name;
    this.qualifierPart = nextQualifier;
    const saved = await attemptSave();
    if (saved) {
      return saved;
    }

    const existing = await findByName(this.name);
    if (existing && existing.thingID === thingID) {
      return existing;
    }

    const parsed = parseInt(nextQualifier, 10);
    nextQualifier = Number.isNaN(parsed) ? `${nextQualifier}2` : String(parsed + 1);
  }
}

module.exports = ThingSlugHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeThingSlugModel;
module.exports.getPostgresThingSlugModel = getPostgresThingSlugModel;
module.exports.reservedSlugs = reservedSlugs;
