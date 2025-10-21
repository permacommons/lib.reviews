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
const { getOrCreateModel } = require('../dal/lib/model-factory');

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
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}invite_links` : 'invite_links';
    
    const schema = {
      id: type.string().uuid(4),
      createdBy: type.string().uuid(4).required(true),
      createdOn: type.date().default(() => new Date()),
      code: type.string().max(50).required(true),
      used: type.boolean().default(false),
      usedBy: type.string().uuid(4),
      usedOn: type.date()
    };

    const { model, isNew } = getOrCreateModel(dal, tableName, schema);
    InviteLink = model;

    if (!isNew) {
      return InviteLink;
    }

    InviteLink._registerFieldMapping('createdBy', 'created_by');
    InviteLink._registerFieldMapping('createdOn', 'created_on');
    InviteLink._registerFieldMapping('usedBy', 'used_by');
    InviteLink._registerFieldMapping('usedOn', 'used_on');

    debug.db('PostgreSQL InviteLink model initialized (stub)');
    return InviteLink;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL InviteLink model:', error);
    return null;
  }
}

// Synchronous handle for production use - proxies to the registered model
// Create synchronous handle using the model handle factory
const { createAutoModelHandle } = require('../dal/lib/model-handle');

const InviteLinkHandle = createAutoModelHandle('invite_links', initializeInviteLinkModel);

module.exports = InviteLinkHandle;

// Export factory function for fixtures and tests
module.exports.initializeModel = initializeInviteLinkModel;
