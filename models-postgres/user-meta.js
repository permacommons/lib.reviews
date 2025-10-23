'use strict';

/**
 * PostgreSQL UserMeta model implementation
 *
 * Provides a versioned metadata store for user profiles (bios),
 * maintaining compatibility with the legacy RethinkDB UserMeta model.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal/lib/ml-string');
const revision = require('../dal/lib/revision');
const { ValidationError } = require('../dal/lib/errors');
const { isValid: isValidLanguage } = require('../locales/languages');
const debug = require('../util/debug');
const { getOrCreateModel } = require('../dal/lib/model-factory');

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
    const tableName = activeDAL.tablePrefix ? `${activeDAL.tablePrefix}user_metas` : 'user_metas';

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

    Object.assign(schema, revision.getSchema());

    const { model, isNew } = getOrCreateModel(activeDAL, tableName, schema, {
      registryKey: 'user_metas'
    });

    UserMeta = model;

    if (!isNew) {
      return UserMeta;
    }

    UserMeta.createFirstRevision = revision.getFirstRevisionHandler(UserMeta);
    UserMeta.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(UserMeta);
    UserMeta.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(UserMeta);
    UserMeta.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(UserMeta);

    UserMeta.define('deleteAllRevisions', revision.getDeleteAllRevisionsHandler(UserMeta));

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
