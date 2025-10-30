'use strict';

let postgresModulePromise;
async function loadDbPostgres() {
  if (!postgresModulePromise) {
    postgresModulePromise = import('../db-postgres.mjs');
  }
  return postgresModulePromise;
}

async function getPostgresDAL() {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const type = require('../dal').type;
const debug = require('../util/debug');
const { initializeModel } = require('../dal/lib/model-initializer');
const { ConstraintError, DuplicateSlugNameError } = require('../dal/lib/errors');

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
      },
      staticMethods: {
        getByName
      },
      instanceMethods: {
        qualifiedSave
      }
    });

    TeamSlug = model;

    if (!isNew) {
      return TeamSlug;
    }

    debug.db('PostgreSQL TeamSlug model initialized');
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

/**
 * Get a team slug by its name field.
 *
 * @param {string} name - The slug name to look up
 * @returns {Promise<TeamSlug|null>} The team slug instance or null if not found
 * @static
 * @memberof TeamSlug
 */
async function getByName(name) {
  try {
    return await this.filter({ name }).first();
  } catch (error) {
    debug.error(`Error getting team slug by name '${name}':`, error);
    return null;
  }
}

/**
 * For team slugs, we don't do automatic de-duplication (like thing-2, thing-3).
 * A qualifiedSave is just a regular save, but it translates constraint violations
 * into business logic errors that routes can handle.
 *
 * @returns {Promise<TeamSlug>} This slug instance
 * @throws {DuplicateSlugNameError} If a slug with this name already exists
 * @memberof TeamSlug
 * @instance
 */
async function qualifiedSave() {
  if (!this.createdOn) {
    this.createdOn = new Date();
  }

  try {
    return await this.save();
  } catch (error) {
    // Translate database constraint violations into business logic errors
    // This keeps route handlers from needing to know about constraint names
    if (error instanceof ConstraintError && error.constraint === 'team_slugs_slug_unique') {
      throw new DuplicateSlugNameError(
        `Team slug '${this.name}' already exists`,
        this.name,
        'team_slugs'
      );
    }
    throw error;
  }
}

module.exports = TeamSlugHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeTeamSlugModel;
module.exports.getPostgresTeamSlugModel = getPostgresTeamSlugModel;
