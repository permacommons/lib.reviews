'use strict';

/**
 * PostgreSQL File model implementation
 * 
 * This is the full PostgreSQL implementation of the File model using the DAL,
 * maintaining compatibility with the existing RethinkDB File model interface.
 */

const { getPostgresDAL } = require('../db-dual');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');

const validLicenses = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'];

let File = null;

/**
 * Initialize the PostgreSQL File model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function initializeFileModel(customDAL = null) {
  const dal = customDAL || getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping File model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}files` : 'files';
    
    // Create the schema with revision fields
    const fileSchema = {
      id: type.string().uuid(4),
      name: type.string().max(512),
      description: mlString.getSchema(),
      uploaded_by: type.string().uuid(4),
      uploaded_on: type.date(),
      mime_type: type.string(),
      license: type.string().enum(validLicenses),
      // Provided by uploader: if not the author, who is?
      creator: mlString.getSchema(),
      // Provided by uploader: where does this file come from?
      source: mlString.getSchema(),
      // Uploaded files with incomplete metadata are stored in a separate directory
      completed: type.boolean().default(false),
      
      // Virtual permission fields
      user_can_delete: type.virtual().default(false),
      user_is_creator: type.virtual().default(false)
    };

    // Add revision fields to schema
    Object.assign(fileSchema, revision.getSchema());

    File = dal.createModel(tableName, fileSchema);

    // Add static methods
    File.createFirstRevision = revision.getFirstRevisionHandler(File);
    File.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(File);
    File.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(File);
    File.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(File);

    // Custom static methods
    File.getStashedUpload = getStashedUpload;
    File.getValidLicenses = getValidLicenses;
    File.getFileFeed = getFileFeed;

    // Add instance methods
    File.define("newRevision", revision.getNewRevisionHandler(File));
    File.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(File));
    File.define("populateUserInfo", populateUserInfo);

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

  this.user_is_creator = user.id === this.uploaded_by;
  this.user_can_delete = this.user_is_creator || user.is_super_user || user.is_site_moderator || false;
}

/**
 * Get the PostgreSQL File model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function getPostgresFileModel(customDAL = null) {
  if (!File || customDAL) {
    File = initializeFileModel(customDAL);
  }
  return File;
}

module.exports = {
  initializeFileModel,
  getPostgresFileModel
};