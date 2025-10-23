'use strict';

/**
 * PostgreSQL Team model implementation
 * 
 * This is the full PostgreSQL implementation of the Team model using the DAL,
 * maintaining compatibility with the existing RethinkDB Team model interface.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');
const isValidLanguage = require('../locales/languages').isValid;
const { getPostgresUserModel } = require('./user');
const { getPostgresReviewModel } = require('./review');
const { getOrCreateModel } = require('../dal/lib/model-factory');

let Team = null;

/**
 * Initialize the PostgreSQL Team model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeTeamModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping Team model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}teams` : 'teams';
    
    // Create the schema with revision fields and JSONB columns
    const teamSchema = {
      id: type.string().uuid(4),
      
      // JSONB multilingual fields
      name: mlString.getSchema({ maxLength: 100 }),
      motto: mlString.getSchema({ maxLength: 200 }),
      description: type.object().validator(_validateTextHtmlObject),
      rules: type.object().validator(_validateTextHtmlObject),
      
      // CamelCase relational fields that map to snake_case database columns
      modApprovalToJoin: type.boolean().default(false),
      onlyModsCanBlog: type.boolean().default(false),
      createdBy: type.string().uuid(4).required(true),
      createdOn: type.date().required(true),
      canonicalSlugName: type.string(),
      originalLanguage: type.string().max(4).validator(isValidLanguage),
      
      // JSONB for permissions configuration
      confersPermissions: type.object().validator(_validateConfersPermissions),
      
      // Virtual fields for feeds and permissions
      reviewOffsetDate: type.virtual().default(null),
      userIsFounder: type.virtual().default(false),
      userIsMember: type.virtual().default(false),
      userIsModerator: type.virtual().default(false),
      userCanBlog: type.virtual().default(false),
      userCanJoin: type.virtual().default(false),
      userCanLeave: type.virtual().default(false),
      userCanEdit: type.virtual().default(false),
      userCanDelete: type.virtual().default(false),
      
      urlID: type.virtual().default(function() {
        const slugName = this.getValue ? this.getValue('canonicalSlugName') : this.canonicalSlugName;
        return slugName ? encodeURIComponent(slugName) : this.id;
      })
    };

    // Add revision fields to schema
    Object.assign(teamSchema, revision.getSchema());

    const { model, isNew } = getOrCreateModel(dal, tableName, teamSchema);
    Team = model;

    if (!isNew) {
      return Team;
    }

    // Register camelCase to snake_case field mappings
    Team._registerFieldMapping('modApprovalToJoin', 'mod_approval_to_join');
    Team._registerFieldMapping('onlyModsCanBlog', 'only_mods_can_blog');
    Team._registerFieldMapping('createdBy', 'created_by');
    Team._registerFieldMapping('createdOn', 'created_on');
    Team._registerFieldMapping('canonicalSlugName', 'canonical_slug_name');
    Team._registerFieldMapping('originalLanguage', 'original_language');
    Team._registerFieldMapping('confersPermissions', 'confers_permissions');

    // Add static methods
    Team.createFirstRevision = revision.getFirstRevisionHandler(Team);
    Team.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(Team);
    Team.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(Team);

    // Custom static methods
    Team.getWithData = getWithData;

    // Add instance methods
    Team.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(Team));
    Team.define("populateUserInfo", populateUserInfo);

    debug.db('PostgreSQL Team model initialized with all methods');
    return Team;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL Team model:', error);
    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Retrieve a team and some of the joined data like reviews or members
 *
 * @param {String} id - the team to look up
 * @param {Object} [options] - query criteria
 * @param {Boolean} options.withMembers=true - get the user objects representing the members
 * @param {Boolean} options.withModerators=true - get the user objects representing the moderators
 * @param {Boolean} options.withJoinRequests=true - get the pending requests to join this team
 * @param {Boolean} options.withJoinRequestDetails=false - get user objects for join requests
 * @param {Boolean} options.withReviews=false - get reviews associated with this team
 * @param {Number} options.reviewLimit=1 - get up to this number of reviews
 * @param {Date} options.reviewOffsetDate - only get reviews older than this date
 * @returns {Team} team with joined data
 * @async
 */
async function getWithData(id, {
  withMembers = true,
  withModerators = true,
  withJoinRequests = true,
  withJoinRequestDetails = false,
  withReviews = false,
  reviewLimit = 1,
  reviewOffsetDate = null
} = {}) {

  // For now, get the basic team record
  const team = await Team.getNotStaleOrDeleted(id);

  // Join implementations would need proper many-to-many relationship handling
  if (withMembers) {
    team.members = await _getTeamMembers(id);
  }

  if (withModerators) {
    team.moderators = await _getTeamModerators(id);
  }

  if (withJoinRequests) {
    team.joinRequests = await _getTeamJoinRequests(id, withJoinRequestDetails);
  }

  if (withReviews) {
    const reviewData = await _getTeamReviews(id, reviewLimit, reviewOffsetDate);
    team.reviews = reviewData.reviews;
    team.reviewCount = reviewData.totalCount;

    if (reviewData.hasMore && team.reviews.length > 0) {
      const lastReview = team.reviews[team.reviews.length - 1];
      const offsetDate = lastReview?.createdOn || lastReview?.created_on;
      if (offsetDate) {
        team.reviewOffsetDate = offsetDate;
        team.review_offset_date = offsetDate;
      }
    }
  }

  return team;
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Populate the virtual permission and metadata fields for this team with
 * information for a given user.
 *
 * @param {User} user - user whose permissions and metadata to use
 * @memberof Team
 * @instance
 */
function populateUserInfo(user) {
  if (!user) {
    return; // Permissions remain at defaults (false)
  }

  const team = this;
  
  // Check membership
  if (team.members && team.members.some(member => member.id === user.id)) {
    team.userIsMember = true;
  }

  // Check moderator status
  if (team.moderators && team.moderators.some(moderator => moderator.id === user.id)) {
    team.userIsModerator = true;
  }

  // Check founder status
  if (user.id === team.createdBy) {
    team.userIsFounder = true;
  }

  // Determine blogging permissions
  if (team.userIsMember && (!team.onlyModsCanBlog || team.userIsModerator)) {
    team.userCanBlog = true;
  }

  // Determine join permissions (can't join if already member or has pending request)
  if (!team.userIsMember && 
      (!team.joinRequests || !team.joinRequests.some(request => request.userID === user.id))) {
    team.userCanJoin = true;
  }

  // Determine edit permissions
  if (team.userIsFounder || team.userIsModerator || user.isSuperUser) {
    team.userCanEdit = true;
  }

  // Determine delete permissions (only site-wide mods for now)
  if (user.isSuperUser || user.isSiteModerator) {
    team.userCanDelete = true;
  }

  // Determine leave permissions (founders can't leave, must delete team)
  if (!team.userIsFounder && team.userIsMember) {
    team.userCanLeave = true;
  }
}

// Helper functions for joins (these would need proper implementation with join tables)

/**
 * Get team members from join table
 * @param {String} teamId - Team ID
 * @returns {Promise<User[]>} Array of user objects
 */
async function _getTeamMembers(teamId) {
  try {
    const memberTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}team_members` : 'team_members';
    const userTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}users` : 'users';
    
    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${memberTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;
    
    const result = await Team.dal.query(query, [teamId]);
    const User = await getPostgresUserModel(Team.dal);

    return result.rows.map(row => {
      delete row.password;
      return User._createInstance(row);
    });
  } catch (error) {
    debug.error('Error getting team members:', error);
    return [];
  }
}

/**
 * Get team moderators from join table
 * @param {String} teamId - Team ID
 * @returns {Promise<User[]>} Array of user objects
 */
async function _getTeamModerators(teamId) {
  try {
    const moderatorTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}team_moderators` : 'team_moderators';
    const userTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}users` : 'users';
    
    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${moderatorTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;
    
    const result = await Team.dal.query(query, [teamId]);
    const User = await getPostgresUserModel(Team.dal);

    return result.rows.map(row => {
      delete row.password;
      return User._createInstance(row);
    });
  } catch (error) {
    debug.error('Error getting team moderators:', error);
    return [];
  }
}

/**
 * Get team join requests
 * @param {String} teamId - Team ID
 * @param {Boolean} withDetails - Whether to include user details
 * @returns {Promise<Object[]>} Array of join request objects
 */
async function _getTeamJoinRequests(teamId, withDetails = false) {
  try {
    const joinRequestTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}team_join_requests` : 'team_join_requests';
    
    let query = `SELECT * FROM ${joinRequestTableName} WHERE team_id = $1`;
    
    if (withDetails) {
      const userTableName = Team.dal.tablePrefix ? 
        `${Team.dal.tablePrefix}users` : 'users';
      query = `
        SELECT jr.*, u.display_name, u.url_name 
        FROM ${joinRequestTableName} jr
        JOIN ${userTableName} u ON jr.user_id = u.id
        WHERE jr.team_id = $1
      `;
    }
    
    const result = await Team.dal.query(query, [teamId]);
    return result.rows;
  } catch (error) {
    debug.error('Error getting team join requests:', error);
    return [];
  }
}

/**
 * Get team reviews with pagination
 * @param {String} teamId - Team ID
 * @param {Number} limit - Maximum number of reviews
 * @param {Date} offsetDate - Date offset for pagination
 * @returns {Promise<Object>} Object with reviews array and total count
 */
async function _getTeamReviews(teamId, limit, offsetDate) {
  try {
    const reviewTeamTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}review_teams` : 'review_teams';
    const reviewTableName = Team.dal.tablePrefix ? 
      `${Team.dal.tablePrefix}reviews` : 'reviews';
    const Review = await getPostgresReviewModel(Team.dal);
    
    let query = `
      SELECT r.id, r.created_on FROM ${reviewTableName} r
      JOIN ${reviewTeamTableName} rt ON r.id = rt.review_id
      WHERE rt.team_id = $1
        AND (r._old_rev_of IS NULL)
        AND (r._rev_deleted IS NULL OR r._rev_deleted = false)
    `;
    
    const params = [teamId];
    let paramIndex = 2;
    
    if (offsetDate) {
      query += ` AND r.created_on < $${paramIndex}`;
      params.push(offsetDate);
      paramIndex++;
    }
    
    query += ` ORDER BY r.created_on DESC LIMIT $${paramIndex}`;
    params.push(limit + 1);
    
    // Get reviews
    const reviewResult = await Team.dal.query(query, params);
    const reviewIDs = reviewResult.rows.map(row => row.id);
    const reviews = [];
    const hasMoreRows = reviewResult.rows.length > limit;

    for (const id of reviewIDs) {
      try {
        const review = await Review.getWithData(id);
        if (review) {
          reviews.push(review);
        }
      } catch (error) {
        debug.error('Error loading review for team:', error);
      }
    }
    
    if (hasMoreRows && reviews.length > limit) {
      reviews.length = limit;
    }
    
    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total FROM ${reviewTableName} r
      JOIN ${reviewTeamTableName} rt ON r.id = rt.review_id
      WHERE rt.team_id = $1
        AND (r._old_rev_of IS NULL)
        AND (r._rev_deleted IS NULL OR r._rev_deleted = false)
    `;
    
    const countResult = await Team.dal.query(countQuery, [teamId]);
    
    return {
      reviews,
      totalCount: parseInt(countResult.rows[0]?.total || 0, 10),
      hasMore: hasMoreRows && reviews.length === limit
    };
  } catch (error) {
    debug.error('Error getting team reviews:', error);
    return { reviews: [], totalCount: 0, hasMore: false };
  }
}

// Validation functions

/**
 * Validate text/html object structure for description and rules
 * @param {Object} value - Object to validate
 * @returns {Boolean} true if valid
 */
function _validateTextHtmlObject(value) {
  if (value === null || value === undefined) {
    return true;
  }
  
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Description/rules must be an object with text and html properties');
  }
  
  // Should have text and html properties, both multilingual strings
  if (value.text !== undefined) {
    mlString.validate(value.text);
  }
  
  if (value.html !== undefined) {
    mlString.validate(value.html);
  }
  
  return true;
}

/**
 * Validate confers_permissions object structure
 * @param {Object} value - Object to validate
 * @returns {Boolean} true if valid
 */
function _validateConfersPermissions(value) {
  if (value === null || value === undefined) {
    return true;
  }
  
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Confers permissions must be an object');
  }
  
  // Validate known permission fields
  const validPermissions = ['show_error_details', 'translate'];
  for (const [key, val] of Object.entries(value)) {
    if (validPermissions.includes(key)) {
      if (typeof val !== 'boolean') {
        throw new Error(`Permission ${key} must be a boolean`);
      }
    }
  }
  
  return true;
}

/**
 * Get the PostgreSQL Team model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresTeamModel(customDAL = null) {
  if (!Team || customDAL) {
    Team = await initializeTeamModel(customDAL);
  }
  return Team;
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const TeamHandle = createAutoModelHandle('teams', initializeTeamModel);

module.exports = TeamHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeTeamModel;
module.exports.initializeTeamModel = initializeTeamModel; // Backward compatibility
module.exports.getPostgresTeamModel = getPostgresTeamModel;
