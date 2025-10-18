'use strict';

/**
 * PostgreSQL User model - test implementation
 * 
 * This is a test implementation of the User model using the new PostgreSQL DAL
 * to verify compatibility and functionality alongside the existing RethinkDB model.
 */

const { getPostgresDAL } = require('../db-dual');
const type = require('../dal').type;
const debug = require('../util/debug');

let User = null;

/**
 * Initialize the PostgreSQL User model
 */
function initializeUserModel() {
  const dal = getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping User model initialization');
    return null;
  }

  try {
    User = dal.createModel('users', {
      id: type.string().uuid(4),
      display_name: type.string().max(128).required(),
      canonical_name: type.string().max(128).required(),
      email: type.string().max(128).email(),
      password: type.string(),
      user_meta_id: type.string().uuid(4),
      invite_link_count: type.number().integer().default(0),
      registration_date: type.date().default(() => new Date()),
      show_error_details: type.boolean().default(false),
      is_trusted: type.boolean().default(false),
      is_site_moderator: type.boolean().default(false),
      is_super_user: type.boolean().default(false),
      suppressed_notices: type.array(type.string()),
      prefers_rich_text_editor: type.boolean().default(false),
      
      // Virtual fields for compatibility
      url_name: type.virtual().default(function() {
        return this.display_name ? encodeURIComponent(this.display_name.replace(/ /g, '_')) : undefined;
      }),
      user_can_edit_metadata: type.virtual().default(false),
      user_can_upload_temp_files: type.virtual().default(function() {
        return this.is_trusted || this.is_super_user;
      })
    });

    debug.db('PostgreSQL User model initialized');
    return User;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL User model:', error);
    return null;
  }
}

/**
 * Get the PostgreSQL User model (initialize if needed)
 */
function getPostgresUserModel() {
  if (!User) {
    User = initializeUserModel();
  }
  return User;
}

module.exports = {
  initializeUserModel,
  getPostgresUserModel
};