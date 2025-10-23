'use strict';

/**
 * PostgreSQL InviteLink model implementation (stub)
 * 
 * This is a minimal stub implementation for the InviteLink model.
 * Full implementation will be added as needed.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const debug = require('../util/debug');
const config = require('config');
const isUUID = require('is-uuid');
const { randomUUID } = require('crypto');
const { DocumentNotFound } = require('../dal/lib/errors');
const { getOrCreateModel } = require('../dal/lib/model-factory');

let InviteLink = null;

/**
 * Initialize the PostgreSQL InviteLink model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeInviteLinkModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping InviteLink model initialization');
    return null;
  }

  try {
    const tableName = activeDAL.tablePrefix ? `${activeDAL.tablePrefix}invite_links` : 'invite_links';
    
    const schema = {
      id: type.string().uuid(4).default(() => randomUUID()),
      createdBy: type.string().uuid(4).required(true),
      createdOn: type.date().default(() => new Date()),
      usedBy: type.string().uuid(4),
      url: type.virtual().default(function() {
        const identifier = this.getValue ? this.getValue('id') : this.id;
        return identifier ? `${config.qualifiedURL}register/${identifier}` : undefined;
      })
    };

    const { model, isNew } = getOrCreateModel(activeDAL, tableName, schema, {
      registryKey: 'invite_links'
    });
    InviteLink = model;

    if (isNew) {
      InviteLink._registerFieldMapping('createdBy', 'created_by');
      InviteLink._registerFieldMapping('createdOn', 'created_on');
      InviteLink._registerFieldMapping('usedBy', 'used_by');
      debug.db('PostgreSQL InviteLink model initialized');
    }
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL InviteLink model:', error);
    return null;
  }

  InviteLink.getAvailable = getAvailable;
  InviteLink.getUsed = getUsed;
  InviteLink.get = getInviteByID;

  return InviteLink;
}

/**
 * Build the canonical registration URL for an invite link instance.
 *
 * @param {Object} invite - Invite link instance or plain object
 * @returns {string|undefined} Fully qualified invite URL
 */
function buildInviteURL(invite) {
  if (!invite) {
    return undefined;
  }
  const identifier = invite.id;
  return identifier ? `${config.qualifiedURL}register/${identifier}` : undefined;
}

/**
 * Normalize fields on a hydrated invite link instance.
 *
 * @param {Object} invite - Invite link instance
 * @returns {Object} The normalized invite instance
 */
function normalizeInviteInstance(invite) {
  if (!invite) {
    return invite;
  }
  invite.url = buildInviteURL(invite);
  return invite;
}

/**
 * Get pending invite links created by the given user.
 *
 * @param {Object} user - User whose pending invites to load
 * @param {string} user.id - User identifier
 * @returns {Promise<Object[]>} Pending invite links, newest first
 */
async function getAvailable(user) {
  if (!user || !user.id) {
    return [];
  }

  try {
    const query = `
      SELECT *
      FROM ${InviteLink.tableName}
      WHERE created_by = $1
        AND (used_by IS NULL)
      ORDER BY created_on DESC
    `;

    const result = await InviteLink.dal.query(query, [user.id]);
    return result.rows.map(row => normalizeInviteInstance(InviteLink._createInstance(row)));
  } catch (error) {
    debug.error('Failed to fetch pending invite links:', error);
    return [];
  }
}

/**
 * Get redeemed invite links created by the given user, including user info.
 *
 * @param {Object} user - User whose redeemed invites to load
 * @param {string} user.id - User identifier
 * @returns {Promise<Object[]>} Redeemed invite links, newest first
 */
async function getUsed(user) {
  if (!user || !user.id) {
    return [];
  }

  try {
    const query = `
      SELECT *
      FROM ${InviteLink.tableName}
      WHERE created_by = $1
        AND used_by IS NOT NULL
      ORDER BY created_on DESC
    `;

    const result = await InviteLink.dal.query(query, [user.id]);
    const invites = result.rows.map(row => normalizeInviteInstance(InviteLink._createInstance(row)));

    const usedByIds = [...new Set(invites.map(invite => invite.usedBy).filter(Boolean))];
    if (usedByIds.length === 0) {
      return invites;
    }

    const userQuery = `
      SELECT id, display_name, canonical_name, registration_date, is_trusted, is_site_moderator, is_super_user
      FROM users
      WHERE id = ANY($1)
    `;
    const userResult = await InviteLink.dal.query(userQuery, [usedByIds]);
    const userMap = new Map();

    userResult.rows.forEach(row => {
      userMap.set(row.id, {
        ...row,
        displayName: row.display_name,
        urlName: row.canonical_name || (row.display_name ? encodeURIComponent(row.display_name.replace(/ /g, '_')) : undefined),
        registrationDate: row.registration_date
      });
    });

    invites.forEach(invite => {
      if (invite.usedBy && userMap.has(invite.usedBy)) {
        invite.usedByUser = userMap.get(invite.usedBy);
      }
    });

    return invites;
  } catch (error) {
    debug.error('Failed to fetch redeemed invite links:', error);
    return [];
  }
}

/**
 * Fetch a single invite link by its identifier.
 *
 * @param {string} id - Invite link identifier (UUID)
 * @returns {Promise<Object>} Invite link instance
 * @throws {DocumentNotFound} When no invite with the provided id exists
 */
async function getInviteByID(id) {
  if (!id) {
    const error = new DocumentNotFound('Invite link not found');
    error.name = 'DocumentNotFoundError';
    throw error;
  }

  if (!isUUID.v4(id)) {
    const error = new DocumentNotFound(`invite_links with id ${id} not found`);
    error.name = 'DocumentNotFoundError';
    throw error;
  }

  try {
    const query = `
      SELECT *
      FROM ${InviteLink.tableName}
      WHERE id = $1
      LIMIT 1
    `;

    const result = await InviteLink.dal.query(query, [id]);
    if (result.rows.length === 0) {
      const error = new DocumentNotFound(`invite_links with id ${id} not found`);
      error.name = 'DocumentNotFoundError';
      throw error;
    }

    return normalizeInviteInstance(InviteLink._createInstance(result.rows[0]));
  } catch (error) {
    if (error instanceof DocumentNotFound || error.name === 'DocumentNotFoundError') {
      throw error;
    }
    debug.error('Failed to fetch invite link by id:', error);
    throw error;
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const InviteLinkHandle = createAutoModelHandle('invite_links', initializeInviteLinkModel);

/**
 * Obtain the PostgreSQL InviteLink model, initializing if necessary.
 *
 * @param {DataAccessLayer} [dal] - Optional DAL for testing
 * @returns {Promise<Function|null>} Initialized model constructor or null
 */
async function getPostgresInviteLinkModel(dal = null) {
  InviteLink = await initializeInviteLinkModel(dal);
  return InviteLink;
}

module.exports = InviteLinkHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeInviteLinkModel;
module.exports.initializeInviteLinkModel = initializeInviteLinkModel; // Backward compatibility
module.exports.getPostgresInviteLinkModel = getPostgresInviteLinkModel;
