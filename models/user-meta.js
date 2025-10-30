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
const mlString = require('../dal/lib/ml-string');
const { ValidationError } = require('../dal/lib/errors');
const { isValid: isValidLanguage } = require('../locales/languages');
const debug = require('../util/debug');
const { initializeModel } = require('../dal/lib/model-initializer');

let UserMeta = null;

/**
 * Initialize the PostgreSQL UserMeta model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 * @returns {Promise<Model|null>} Initialized model or null if DAL unavailable
 */
async function initializeUserMetaModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping UserMeta model initialization');
    return null;
  }

  try {
    const multilingualStringSchema = mlString.getSchema({ maxLength: 1000 });

    const bioType = type.object()
      .default(() => ({
        text: {},
        html: {}
      }))
      .validator(value => {
        if (value === null || value === undefined) {
          return true;
        }

        multilingualStringSchema.validate(value.text, 'bio.text');
        multilingualStringSchema.validate(value.html, 'bio.html');
        return true;
      });

    const schema = {
      id: type.string().uuid(4),
      bio: bioType,
      originalLanguage: type.string()
        .max(4)
        .required(true)
        .validator(lang => {
          if (lang === null || lang === undefined) {
            return true;
          }
          if (!isValidLanguage(lang)) {
            throw new ValidationError(`Invalid language code: ${lang}`, 'originalLanguage');
          }
          return true;
        })
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'user_metas',
      schema,
      camelToSnake: {
        originalLanguage: 'original_language'
      },
      withRevision: {
        static: [
          'createFirstRevision',
          'getNotStaleOrDeleted',
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted'
        ],
        instance: ['deleteAllRevisions']
      }
    });

    UserMeta = model;

    if (!isNew) {
      return UserMeta;
    }

    return UserMeta;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL UserMeta model:', error);
    return null;
  }
}

/**
 * Retrieve the initialized UserMeta model, creating it if necessary
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 * @returns {Promise<Model|null>} UserMeta model or null if unavailable
 */
async function getPostgresUserMetaModel(dal = null) {
  UserMeta = await initializeUserMetaModel(dal);
  return UserMeta;
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const UserMetaHandle = createAutoModelHandle('user_metas', initializeUserMetaModel);

module.exports = UserMetaHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeUserMetaModel;
module.exports.getPostgresUserMetaModel = getPostgresUserMetaModel;
