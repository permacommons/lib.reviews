'use strict';

/**
 * PostgreSQL BlogPost model implementation
 * 
 * This is the PostgreSQL implementation of the BlogPost model using the DAL,
 * maintaining compatibility with the existing RethinkDB BlogPost model interface.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal/lib/ml-string');
const revision = require('../dal/lib/revision');
const isValidLanguage = require('../locales/languages').isValid;
const debug = require('../util/debug');

let BlogPost = null;

/**
 * Initialize the PostgreSQL BlogPost model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeBlogPostModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping BlogPost model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}blog_posts` : 'blog_posts';
    BlogPost = dal.createModel(tableName, {
      id: type.string().uuid(4),
      team_id: type.string().uuid(4).required(),
      title: type.object(), // multilingual string
      post: type.object(), // { text: mlString, html: mlString }
      created_on: type.date().default(() => new Date()),
      created_by: type.string().uuid(4).required(),
      original_language: type.string().max(4).required().validator(isValidLanguage),
      // Revision fields
      ...revision.getSchema()
    });

    // Add virtual fields
    BlogPost.prototype.userCanEdit = false;
    BlogPost.prototype.userCanDelete = false;

    debug.db('PostgreSQL BlogPost model initialized');
    return BlogPost;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL BlogPost model:', error);
    throw error;
  }
}

/**
 * Get the PostgreSQL BlogPost model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresBlogPostModel(customDAL = null) {
  if (!BlogPost || customDAL) {
    BlogPost = await initializeBlogPostModel(customDAL);
  }
  return BlogPost;
}

module.exports = {
  initializeBlogPostModel,
  getPostgresBlogPostModel
};