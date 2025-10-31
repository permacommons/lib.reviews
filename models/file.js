import dal from '../dal/index.js';
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

const validLicenses = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'];

let File = null;

/**
 * Initialize the PostgreSQL File model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeFileModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping File model initialization');
    return null;
  }

  try {
    // Create the schema with revision fields
    const fileSchema = {
      id: types.string().uuid(4),
      name: types.string().max(512),
      description: mlString.getSchema(),
      
      // CamelCase fields that map to snake_case database columns
      uploadedBy: types.string().uuid(4),
      uploadedOn: types.date(),
      mimeType: types.string(),
      license: types.string().enum(validLicenses),
      
      // Provided by uploader: if not the author, who is?
      creator: mlString.getSchema(),
      // Provided by uploader: where does this file come from?
      source: mlString.getSchema(),
      // Uploaded files with incomplete metadata are stored in a separate directory
      completed: types.boolean().default(false),
      
      // Virtual permission fields
      userCanDelete: types.virtual().default(false),
      userIsCreator: types.virtual().default(false)
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'files',
      schema: fileSchema,
      camelToSnake: {
        uploadedBy: 'uploaded_by',
        uploadedOn: 'uploaded_on',
        mimeType: 'mime_type'
      },
      withRevision: {
        static: [
          'createFirstRevision',
          'getNotStaleOrDeleted',
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted'
        ],
        instance: ['deleteAllRevisions']
      },
      staticMethods: {
        getStashedUpload,
        getValidLicenses,
        getFileFeed
      },
      instanceMethods: {
        populateUserInfo
      },
      relations: [
        {
          name: 'uploader',
          targetTable: 'users',
          sourceKey: 'uploaded_by',
          targetKey: 'id',
          hasRevisions: false,
          cardinality: 'one'
        },
        {
          name: 'things',
          targetTable: 'things',
          sourceKey: 'id',
          targetKey: 'id',
          hasRevisions: true,
          through: {
            table: 'thing_files',
            sourceForeignKey: 'file_id',
            targetForeignKey: 'thing_id'
          },
          cardinality: 'many'
        }
      ]
    });
    File = model;

    if (!isNew) {
      return File;
    }

    debug.db('PostgreSQL File model initialized with all methods');
    return File;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL File model:', error);
    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Get a stashed (incomplete) upload by user ID and name
 *
 * @param {String} userID - User ID who uploaded the file
 * @param {String} name - File name
 * @returns {Promise<File|undefined>} File instance or undefined if not found
 * @async
 */
async function getStashedUpload(userID, name) {
  const query = `
    SELECT * FROM ${File.tableName} 
    WHERE name = $1 
      AND uploaded_by = $2 
      AND completed = false 
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
      AND (_old_rev_of IS NULL)
    LIMIT 1
  `;
  
  const result = await File.dal.query(query, [name, userID]);
  return result.rows.length > 0 ? File._createInstance(result.rows[0]) : undefined;
}

/**
 * Get array of valid license values
 *
 * @returns {String[]} Array of valid license strings
 */
function getValidLicenses() {
  return validLicenses.slice();
}

/**
 * Get a feed of completed files with pagination
 *
 * @param {Object} options - Feed options
 * @param {Date} options.offsetDate - Date for pagination offset
 * @param {Number} options.limit - Maximum number of items to return (default: 10)
 * @returns {Promise<Object>} Feed object with items and optional offsetDate
 * @async
 */
async function getFileFeed({ offsetDate, limit = 10 } = {}) {
  let query = File.filter({ completed: true })
    .filterNotStaleOrDeleted()
    .getJoin({ uploader: true })
    .orderBy('uploadedOn', 'DESC');

  if (offsetDate && offsetDate.valueOf) {
    query = query.filter(row => row('uploadedOn').lt(offsetDate));
  }

  // Get one extra to check for more results
  const items = await query.limit(limit + 1).run();

  const feed = {
    items: items.slice(0, limit)
  };

  // At least one additional document available, set offset for pagination
  if (items.length === limit + 1) {
    feed.offsetDate = feed.items[limit - 1].uploadedOn;
  }

  return feed;
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Populate virtual permission fields in a File object with the rights of a
 * given user.
 *
 * @param {User} user - the user whose permissions to check
 * @memberof File
 * @instance
 */
function populateUserInfo(user) {
  if (!user) {
    return; // Permissions will be at their default value (false)
  }

  this.userIsCreator = user.id === this.uploadedBy;
  this.userCanDelete = this.userIsCreator || user.isSuperUser || user.isSiteModerator || false;
}

/**
 * Get the PostgreSQL File model (initialize if needed)
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
*/
async function getPostgresFileModel(dal = null) {
  if (!File || dal) {
    File = await initializeFileModel(dal);
  }
  return File;
}

const FileHandle = createAutoModelHandle('files', initializeFileModel);

export default FileHandle;
export {
  initializeFileModel as initializeModel,
  initializeFileModel,
  getPostgresFileModel
};
