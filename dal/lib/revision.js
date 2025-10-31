import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';

import debug from '../../util/debug.js';
import QueryBuilder from './query-builder.js';
import { DocumentNotFound, InvalidUUIDError, ValidationError } from './errors.js';
import type from './type.js';

/**
 * Revision system handlers for PostgreSQL DAL
 *
 * Provides revision management functionality leveraging PostgreSQL
 * features like partial indexes for performance.
 */

const REVISION_FIELD_MAPPINGS = Object.freeze({
  _revID: '_rev_id',
  _revUser: '_rev_user',
  _revDate: '_rev_date',
  _revTags: '_rev_tags',
  _revDeleted: '_rev_deleted',
  _oldRevOf: '_old_rev_of'
});

/**
 * Revision system handlers
 */
const revision = {

  /**
   * Apply revision metadata to a model instance
   * 
   * Ensures revision fields (_rev_id, _rev_user, _rev_date, _rev_tags) are
   * populated and tracked via the model's change set.
   * 
   * @param {Model} instance - Model instance to stamp
   * @param {Object} options - Metadata options
   * @param {Object} [options.user] - User object providing the ID
   * @param {string} [options.userId] - Explicit user ID (if user object omitted)
   * @param {Date|string} [options.date] - Revision timestamp (defaults to now)
   * @param {string[]|string} [options.tags] - Revision tags
   * @param {string} [options.revId] - Explicit revision ID (generated if absent)
   * @returns {Model} The same model instance for chaining
   */
  applyRevisionMetadata(instance, {
    user = null,
    userId = null,
    date = new Date(),
    tags = [],
    revId = null
  } = {}) {
    const resolvedUserId = user && user.id ? user.id : userId;
    if (!resolvedUserId) {
      throw new ValidationError('Revision metadata requires a user ID');
    }

    const timestamp = date instanceof Date ? date : new Date(date);
    if (!(timestamp instanceof Date) || isNaN(timestamp.getTime())) {
      throw new ValidationError('Revision metadata requires a valid date');
    }

    const resolvedTags = tags == null
      ? []
      : (Array.isArray(tags) ? tags.slice() : [tags]);
    const resolvedRevId = revId || randomUUID();

    instance._rev_id = resolvedRevId;
    instance._rev_user = resolvedUserId;
    instance._rev_date = timestamp;
    instance._rev_tags = resolvedTags;

    return instance;
  },

  /**
   * Get a function that creates a new revision handler for PostgreSQL
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} New revision handler function
   */
  getNewRevisionHandler(ModelClass) {
    /**
     * Create a new revision by archiving the current revision and preparing
     * a new one with updated revision metadata
     * 
     * @param {Object} user - User creating the revision
     * @param {Object} options - Revision options
     * @param {string[]} options.tags - Tags to associate with revision
     * @returns {Promise<Model>} New revision instance
     */
    const newRevision = async function(user, { tags } = {}) {
      const currentRev = this;
      
      // Create old revision copy
      const oldRevData = { ...currentRev._data };
      oldRevData._old_rev_of = currentRev.id;
      delete oldRevData.id; // Let PostgreSQL generate new ID
      
      // Save the old revision
      const insertFields = Object.keys(oldRevData).filter(key => oldRevData[key] !== undefined);
      const insertValues = insertFields.map(key => oldRevData[key]);
      const placeholders = insertFields.map((_, index) => `$${index + 1}`);
      
      const insertQuery = `
        INSERT INTO ${ModelClass.tableName} (${insertFields.join(', ')})
        VALUES (${placeholders.join(', ')})
      `;
      
      await ModelClass.dal.query(insertQuery, insertValues);
      
      // Update current revision with new metadata
      const metadataDate = new Date();
      revision.applyRevisionMetadata(currentRev, {
        user,
        userId: user && user.id,
        date: metadataDate,
        tags
      });
      
      return currentRev;
    };
    
    return newRevision;
  },

  /**
   * Get a function that handles deletion of all revisions
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} Delete all revisions handler
   */
  getDeleteAllRevisionsHandler(ModelClass) {
    /**
     * Mark all revisions as deleted by creating a deletion revision
     * and updating all related revisions
     * 
     * @param {Object} user - User performing the deletion
     * @param {Object} options - Deletion options
     * @param {string[]} options.tags - Tags for the deletion (will prepend 'delete')
     * @returns {Promise<Model>} Deletion revision
     */
    const deleteAllRevisions = async function(user, { tags = [] } = {}) {
      const id = this.id;
      const deletionTags = ['delete', ...tags];
      
      // Create new revision for deletion
      const rev = await this.newRevision(user, { tags: deletionTags });
      rev._data._rev_deleted = true;
      rev._changed.add('_rev_deleted');
      
      // Save the deletion revision
      await rev.save();
      
      // Update all old revisions to mark as deleted
      const updateQuery = `
        UPDATE ${ModelClass.tableName}
        SET _rev_deleted = true
        WHERE _old_rev_of = $1
      `;
      
      await ModelClass.dal.query(updateQuery, [id]);
      
      return rev;
    };
    
    return deleteAllRevisions;
  },

  /**
   * Get a function that retrieves non-stale, non-deleted records
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} Get handler for current revisions
   */
  getNotStaleOrDeletedGetHandler(ModelClass) {
    /**
     * Get a record by ID, ensuring it's not stale or deleted
     * 
     * @param {string} id - Record ID
     * @param {Object} joinOptions - Join options for related data
     * @returns {Promise<Model>} Model instance
     * @throws {Error} If revision is deleted or stale
     */
    const getNotStaleOrDeleted = async function(id, joinOptions = {}) {
      // Validate UUID format before querying database to avoid PostgreSQL syntax errors
      if (!isUUID.v4(id)) {
        throw new InvalidUUIDError(`Invalid ${ModelClass.tableName} address format`);
      }
      
      let data;
      
      if (Object.keys(joinOptions).length > 0) {
        // Use query builder with joins
        const query = new QueryBuilder(ModelClass, ModelClass.dal);
        data = await query
          .filter({ id })
          .getJoin(joinOptions)
          .first();
      } else {
        // Simple get by ID
        const query = `
          SELECT * FROM ${ModelClass.tableName}
          WHERE id = $1
        `;
        const result = await ModelClass.dal.query(query, [id]);
        data = result.rows[0] ? ModelClass._createInstance(result.rows[0]) : null;
      }
      
      if (!data) {
        throw new DocumentNotFound(`${ModelClass.tableName} with id ${id} not found`);
      }
      
      if (data._data._rev_deleted) {
        throw revision.deletedError;
      }
      
      if (data._data._old_rev_of) {
        throw revision.staleError;
      }
      
      return data;
    };
    
    return getNotStaleOrDeleted;
  },

  /**
   * Get a function that creates the first revision of a model
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} First revision creator
   */
  getFirstRevisionHandler(ModelClass) {
    /**
     * Create the first revision of a model instance
     * 
     * @param {Object} user - User creating the first revision
     * @param {Object} options - Revision options
     * @param {string[]} options.tags - Tags to associate with revision
     * @returns {Promise<Model>} First revision instance
     */
    const createFirstRevision = async function(user, { tags, date = new Date() } = {}) {
      const firstRev = new ModelClass({});
      revision.applyRevisionMetadata(firstRev, {
        user,
        userId: user && user.id,
        date,
        tags
      });

      return firstRev;
    };
    
    return createFirstRevision;
  },

  /**
   * Get a function that filters records to exclude stale and deleted revisions
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} Filter function for current revisions
   */
  getNotStaleOrDeletedFilterHandler(ModelClass) {
    /**
     * Filter records to exclude stale and deleted revisions
     * 
     * @returns {QueryBuilder} Query builder with revision filters applied
     */
    const filterNotStaleOrDeleted = function() {
      const query = new QueryBuilder(ModelClass, ModelClass.dal);
      return query.filterNotStaleOrDeleted();
    };
    
    return filterNotStaleOrDeleted;
  },

  /**
   * Get a function that retrieves multiple records by IDs, excluding stale and deleted revisions
   * 
   * @param {Function} ModelClass - The model class
   * @returns {Function} Multiple get handler for current revisions
   */
  getMultipleNotStaleOrDeletedHandler(ModelClass) {
    /**
     * Get multiple records by IDs, excluding stale and deleted revisions
     * 
     * @param {string[]} idArray - Array of record IDs
     * @returns {QueryBuilder} Query builder for chaining
     */
    const getMultipleNotStaleOrDeleted = function(idArray) {
      const query = new QueryBuilder(ModelClass, ModelClass.dal);
      
      // Add condition for multiple IDs
      if (idArray.length > 0) {
        query.whereIn('id', idArray, { cast: 'uuid[]' });
      }

      return query.filterNotStaleOrDeleted();
    };
    
    return getMultipleNotStaleOrDeleted;
  },

  /**
   * Get revision schema fields for PostgreSQL
   * 
   * @returns {Object} Schema fields for revision system
   */
  getSchema() {
    return {
      _rev_user: type.string().uuid(4).required(true),
      _rev_date: type.date().required(true),
      _rev_id: type.string().uuid(4).required(true),
      _old_rev_of: type.string().uuid(4),
      _rev_deleted: type.boolean().default(false),
      _rev_tags: type.array(type.string()).default([])
    };
  }
};

/**
 * Register standard revision field aliases on a model so QueryBuilder
 * can keep using camelCase field names transparently in PostgreSQL.
 *
 * @param {Function} ModelClass - Model constructor returned by initializeModel
 */
revision.registerFieldMappings = function(ModelClass) {
  if (!ModelClass || typeof ModelClass._registerFieldMapping !== 'function') {
    return;
  }

  for (const [camel, snake] of Object.entries(REVISION_FIELD_MAPPINGS)) {
    ModelClass._registerFieldMapping(camel, snake);
  }
};

// Standard revision errors
revision.deletedError = new Error('Revision has been deleted.');
revision.staleError = new Error('Outdated revision.');
revision.deletedError.name = 'RevisionDeletedError';
revision.staleError.name = 'RevisionStaleError';

export { REVISION_FIELD_MAPPINGS, revision };
export default revision;

