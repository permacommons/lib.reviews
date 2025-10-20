'use strict';

/**
 * PostgreSQL InviteLink model implementation
 * 
 * This is the PostgreSQL implementation of the InviteLink model using the DAL,
 * maintaining compatibility with the existing RethinkDB InviteLink model interface.
 */

const { getPostgresDAL } = require('../db-postgres');
const type = require('../dal').type;
const config = require('config');
const debug = require('../util/debug');

let InviteLink = null;

/**
 * Initialize the PostgreSQL InviteLink model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function initializeInviteLinkModel(customDAL = null) {
  const dal = customDAL || await getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping InviteLink model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}invite_links` : 'invite_links';
    InviteLink = dal.createModel(tableName, {
      id: type.string().uuid(4),
      createdOn: type.date().default(() => new Date()),
      createdBy: type.string().uuid(4),
      usedBy: type.string().uuid(4)
    });

    InviteLink._registerFieldMapping('createdOn', 'created_on');
    InviteLink._registerFieldMapping('createdBy', 'created_by');
    InviteLink._registerFieldMapping('usedBy', 'used_by');

    Object.defineProperty(InviteLink.prototype, 'url', {
      get() {
        return `${config.qualifiedURL}register/${this.id}`;
      }
    });

    InviteLink.getAvailable = async function(user) {
      if (!user || !user.id) {
        return [];
      }

      const result = await InviteLink.dal.query(
        `SELECT * FROM ${tableName}
         WHERE created_by = $1 AND used_by IS NULL
         ORDER BY created_on DESC`,
        [user.id]
      );

      return result.rows.map(row => mapRowToInviteLink(row));
    };

    InviteLink.getUsed = async function(user) {
      if (!user || !user.id) {
        return [];
      }

      const result = await InviteLink.dal.query(
        `SELECT * FROM ${tableName}
         WHERE created_by = $1 AND used_by IS NOT NULL
         ORDER BY created_on DESC`,
        [user.id]
      );

      return await attachUsedByUsers(result.rows);
    };

    debug.db('PostgreSQL InviteLink model initialized');
    return InviteLink;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL InviteLink model:', error);
    throw error;
  }
}

function mapRowToInviteLink(row) {
  return InviteLink._createInstance({
    id: row.id,
    createdOn: toDate(row.created_on),
    createdBy: row.created_by,
    usedBy: row.used_by
  });
}

async function attachUsedByUsers(rows) {
  if (!rows.length) {
    return [];
  }

  const usedByIds = [...new Set(rows.map(row => row.used_by).filter(Boolean))];
  const userMap = new Map();

  if (usedByIds.length) {
    const usersTable = InviteLink.dal.tablePrefix ? `${InviteLink.dal.tablePrefix}users` : 'users';
    const placeholders = usedByIds.map((_, index) => `$${index + 1}`).join(', ');

    try {
      const userResult = await InviteLink.dal.query(
        `SELECT id, display_name, canonical_name, registration_date, is_trusted, is_site_moderator, is_super_user
         FROM ${usersTable}
         WHERE id IN (${placeholders})`,
        usedByIds
      );

      userResult.rows.forEach(user => {
        userMap.set(user.id, {
          id: user.id,
          displayName: user.display_name,
          canonicalName: user.canonical_name,
          registrationDate: toDate(user.registration_date),
          isTrusted: user.is_trusted,
          isSiteModerator: user.is_site_moderator,
          isSuperUser: user.is_super_user,
          urlName: user.display_name ? encodeURIComponent(user.display_name.replace(/ /g, '_')) : undefined
        });
      });
    } catch (error) {
      debug.error('Failed to fetch users for invite links:', error);
    }
  }

  return rows.map(row => {
    const invite = mapRowToInviteLink(row);
    if (row.used_by && userMap.has(row.used_by)) {
      invite.usedByUser = userMap.get(row.used_by);
    }
    return invite;
  });
}

function toDate(value) {
  if (!value) {
    return value;
  }
  return value instanceof Date ? value : new Date(value);
}

/**
 * Get the PostgreSQL InviteLink model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
async function getPostgresInviteLinkModel(customDAL = null) {
  if (!InviteLink || customDAL) {
    InviteLink = await initializeInviteLinkModel(customDAL);
  }
  return InviteLink;
}

module.exports = {
  initializeInviteLinkModel,
  getPostgresInviteLinkModel
};
