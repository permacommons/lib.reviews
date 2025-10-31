import dal from '../dal/index.js';
import { ValidationError } from '../dal/lib/errors.js';
import languages from '../locales/languages.js';
import debug from '../util/debug.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';

let postgresModulePromise;
async function loadDbPostgres() {
  if (!postgresModulePromise) {
    postgresModulePromise = import('../db-postgres.js');
  }
  return postgresModulePromise;
}

async function getPostgresDAL() {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { types, mlString } = dal;
const { isValid: isValidLanguage } = languages;

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

    const bioType = types.object()
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
      id: types.string().uuid(4),
      bio: bioType,
      originalLanguage: types.string()
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

const UserMetaHandle = createAutoModelHandle('user_metas', initializeUserMetaModel);

export default UserMetaHandle;
export {
  initializeUserMetaModel as initializeModel,
  initializeUserMetaModel,
  getPostgresUserMetaModel
};
