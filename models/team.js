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

const { createModelModule } = require('../dal/lib/model-handle');
const { proxy: TeamHandle, register: registerTeamHandle } = createModelModule({
  tableName: 'teams'
});

module.exports = TeamHandle;

const type = require('../dal').type;
const mlString = require('../dal').mlString;
const debug = require('../util/debug');
const isValidLanguage = require('../locales/languages').isValid;
const User = require('./user');
const Review = require('./review');
const TeamJoinRequest = require('./team-join-request');
const { initializeModel } = require('../dal/lib/model-initializer');

let Team = null;

/**
 * Initialize the PostgreSQL Team model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeTeamModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping Team model initialization');
    return null;
  }

  try {
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

    const { model, isNew } = initializeModel({
      dal: activeDAL,
      baseTable: 'teams',
      schema: teamSchema,
      camelToSnake: {
        modApprovalToJoin: 'mod_approval_to_join',
        onlyModsCanBlog: 'only_mods_can_blog',
        createdBy: 'created_by',
        createdOn: 'created_on',
        canonicalSlugName: 'canonical_slug_name',
        originalLanguage: 'original_language',
        confersPermissions: 'confers_permissions'
      },
      withRevision: {
        static: [
          'createFirstRevision', 
          'getNotStaleOrDeleted', 
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted'
        ],
        instance: ['newRevision', 'deleteAllRevisions']
      },
      staticMethods: {
        getWithData
      },
      instanceMethods: {
        populateUserInfo,
        updateSlug
      },
      relations: [
        {
          name: 'members',
          targetTable: 'users',
          sourceKey: 'id',
          targetKey: 'id',
          hasRevisions: false,
          through: {
            table: 'team_members',
            sourceForeignKey: 'team_id',
            targetForeignKey: 'user_id'
          },
          cardinality: 'many'
        },
        {
          name: 'moderators',
          targetTable: 'users',
          sourceKey: 'id',
          targetKey: 'id',
          hasRevisions: false,
          through: {
            table: 'team_moderators',
            sourceForeignKey: 'team_id',
            targetForeignKey: 'user_id'
          },
          cardinality: 'many'
        }
      ]
    });
    Team = model;

    if (!isNew) {
      return Team;
    }

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
  // Users can rejoin if their previous request was withdrawn or approved
  if (!team.userIsMember &&
      (!team.joinRequests || !team.joinRequests.some(request =>
        request.userID === user.id && request.status === 'pending'))) {
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
    const memberTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}team_members` : 'team_members';
    const userTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}users` : 'users';
    
    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${memberTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;
    
    const result = await Team.dal.query(query, [teamId]);
    return result.rows.map(row => {
      delete row.password;
      delete row.email;
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
    const moderatorTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}team_moderators` : 'team_moderators';
    const userTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}users` : 'users';
    
    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${moderatorTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;
    
    const result = await Team.dal.query(query, [teamId]);
    return result.rows.map(row => {
      delete row.password;
      delete row.email;
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
  let query = '';
  try {
    const joinRequestTableName = Team.dal.schemaNamespace ?
      `${Team.dal.schemaNamespace}team_join_requests` : 'team_join_requests';

    query = `SELECT * FROM ${joinRequestTableName} WHERE team_id = $1`;
    const result = await Team.dal.query(query, [teamId]);

    // Convert rows to TeamJoinRequest instances
    const requests = result.rows.map(row =>
      TeamJoinRequest._createInstance ?
        TeamJoinRequest._createInstance(row) :
        new TeamJoinRequest(row)
    );

    // If details requested, load the user for each request
    if (withDetails) {
      for (const request of requests) {
        if (request.userID) {
          try {
            const user = await User.get(request.userID);
            if (user) {
              delete user.password;
              request.user = user;
            }
          } catch (error) {
            debug.error(`Error loading user ${request.userID} for join request:`, error);
          }
        }
      }
    }

    return requests;
  } catch (error) {
    debug.error(`Error getting team join requests: ${error.message}`);
    debug.error(`Query: ${query}`);
    debug.error(`Params: ${JSON.stringify([teamId])}`);
    debug.error('Full error:', error);
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
    const reviewTeamTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}review_teams` : 'review_teams';
    const reviewTableName = Team.dal.schemaNamespace ? 
      `${Team.dal.schemaNamespace}reviews` : 'reviews';
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
 * Update the canonical slug name for this team based on its name field.
 * Only updates if the language matches the original language.
 * 
 * @param {String} userID - User ID to attribute the slug creation to
 * @param {String} language - Language to use for slug generation
 * @returns {Team} This team instance with updated canonical slug name
 * @memberof Team
 * @instance
 */
async function updateSlug(userID, language) {
  const TeamSlug = require('./team-slug');
  const originalLanguage = this.originalLanguage || 'en';
  const slugLanguage = language || originalLanguage;

  if (slugLanguage !== originalLanguage) {
    return this;
  }

  if (!this.name) {
    return this;
  }

  const resolved = mlString.resolve(slugLanguage, this.name);
  if (!resolved || typeof resolved.str !== 'string' || !resolved.str.trim()) {
    return this;
  }

  let baseSlug;
  try {
    baseSlug = _generateSlugName(resolved.str);
  } catch (error) {
    return this;
  }

  if (!baseSlug || baseSlug === this.canonicalSlugName) {
    return this;
  }

  if (!this.id) {
    const { randomUUID } = require('crypto');
    this.id = randomUUID();
  }

  const slug = new TeamSlug({});
  slug.slug = baseSlug;
  slug.name = baseSlug;
  slug.teamID = this.id;
  slug.createdOn = new Date();
  slug.createdBy = userID;

  const savedSlug = await slug.qualifiedSave();
  if (savedSlug && savedSlug.name) {
    this.canonicalSlugName = savedSlug.name;
    this._changed.add(Team._getDbFieldName('canonicalSlugName'));
  }

  return this;
}

/**
 * Generate a URL-friendly slug from a string
 * @param {String} str - Source string
 * @returns {String} Slug name
 */
function _generateSlugName(str) {
  const unescapeHTML = require('unescape-html');
  const isUUID = require('is-uuid');
  
  if (typeof str !== 'string') {
    throw new Error('Source string is undefined or not a string.');
  }

  str = str.trim();

  if (str === '') {
    throw new Error('Source string cannot be empty.');
  }

  let slugName = unescapeHTML(str)
    .trim()
    .toLowerCase()
    .replace(/[?&"″'`'<>:]/g, '')
    .replace(/[ _/]/g, '-')
    .replace(/-{2,}/g, '-');

  if (!slugName) {
    throw new Error('Source string cannot be converted to a valid slug.');
  }

  if (isUUID.v4(slugName)) {
    throw new Error('Source string cannot be a UUID.');
  }

  return slugName;
}

registerTeamHandle({
  initializeModel: initializeTeamModel,
  additionalExports: {
    initializeTeamModel
  }
});
