'use strict';

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');
const { initializeModel } = require('../dal/lib/model-initializer');

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
      id: type.string().uuid(4),
      name: type.string().max(512),
      description: mlString.getSchema(),
      
      // CamelCase fields that map to snake_case database columns
      uploadedBy: type.string().uuid(4),
      uploadedOn: type.date(),
      mimeType: type.string(),
      license: type.string().enum(validLicenses),
      
      // Provided by uploader: if not the author, who is?
      creator: mlString.getSchema(),
      // Provided by uploader: where does this file come from?
      source: mlString.getSchema(),
      // Uploaded files with incomplete metadata are stored in a separate directory
      completed: type.boolean().default(false),
      
      // Virtual permission fields
      userCanDelete: type.virtual().default(false),
      userIsCreator: type.virtual().default(false)
    };

    // Add revision fields to schema
    Object.assign(fileSchema, revision.getSchema());

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
      }
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
  // Get the User model table name (might have prefix in tests)
  const userTableName = File.dal.tablePrefix ? `${File.dal.tablePrefix}users` : 'users';
  
  let query = `
    SELECT f.*, 
           u.display_name as uploader_display_name,
           u.url_name as uploader_url_name
    FROM ${File.tableName} f
    LEFT JOIN ${userTableName} u ON f.uploaded_by = u.id
    WHERE f.completed = true 
      AND (f._rev_deleted IS NULL OR f._rev_deleted = false)
      AND (f._old_rev_of IS NULL)
  `;
  
  const params = [];
  let paramIndex = 1;
  
  if (offsetDate && offsetDate.valueOf) {
    query += ` AND f.uploaded_on < $${paramIndex}`;
    params.push(offsetDate);
    paramIndex++;
  }
  
  query += ` ORDER BY f.uploaded_on DESC LIMIT $${paramIndex}`;
  params.push(limit + 1); // Get one extra to check for more results
  
  const result = await File.dal.query(query, params);
  const items = result.rows.slice(0, limit).map(row => {
    const file = File._createInstance(row);
    // Add uploader info if available
    if (row.uploader_display_name) {
      file.uploader = {
        display_name: row.uploader_display_name,
        url_name: row.uploader_url_name
      };
    }
    return file;
  });
  
  const feed = { items };
  
  // At least one additional document available, set offset for pagination
  if (result.rows.length === limit + 1) {
    feed.offsetDate = items[limit - 1].uploaded_on;
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

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const FileHandle = createAutoModelHandle('files', initializeFileModel);

module.exports = FileHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeFileModel;
module.exports.initializeFileModel = initializeFileModel; // Backward compatibility
module.exports.getPostgresFileModel = getPostgresFileModel;
