import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';
import { DocumentNotFound, InvalidUUIDError, ValidationError } from './errors.ts';
import QueryBuilder from './query-builder.ts';
import types from './type.ts';

/**
 * Revision system handlers for PostgreSQL DAL
 *
 * Provides revision management functionality leveraging PostgreSQL
 * features like partial indexes for performance.
 */

export interface ModelInstance {
  id: string;
  _data: Record<string, any>;
  _changed: Set<string>;
  save(options?: Record<string, unknown>): Promise<this>;
  newRevision(user: unknown, options?: { tags?: string[]; date?: Date }): Promise<this>;
  [key: string]: any;
}

export interface ModelConstructorLike {
  new (data?: Record<string, unknown>): ModelInstance;
  tableName: string;
  dal: {
    query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  };
  _createInstance(row: Record<string, unknown>): ModelInstance;
  _registerFieldMapping?(camel: string, snake: string): void;
}

export interface RevisionHelpers {
  applyRevisionMetadata(
    instance: ModelInstance,
    options?: {
      user?: { id?: string } | null;
      userId?: string | null;
      date?: Date | string;
      tags?: string[] | string | null;
      revId?: string | null;
    }
  ): ModelInstance;
  getNewRevisionHandler(
    ModelClass: ModelConstructorLike
  ): (
    this: ModelInstance,
    user: { id?: string } | null,
    options?: { tags?: string[] }
  ) => Promise<ModelInstance>;
  getDeleteAllRevisionsHandler(
    ModelClass: ModelConstructorLike
  ): (
    this: ModelInstance,
    user: { id?: string } | null,
    options?: { tags?: string[] }
  ) => Promise<ModelInstance>;
  getNotStaleOrDeletedGetHandler(
    ModelClass: ModelConstructorLike
  ): (
    this: ModelInstance,
    id: string,
    joinOptions?: Record<string, unknown>
  ) => Promise<ModelInstance>;
  getFirstRevisionHandler(
    ModelClass: ModelConstructorLike
  ): (
    this: ModelInstance,
    user: { id?: string } | null,
    options?: { tags?: string[]; date?: Date }
  ) => Promise<ModelInstance>;
  getNotStaleOrDeletedFilterHandler(ModelClass: ModelConstructorLike): () => unknown;
  getMultipleNotStaleOrDeletedHandler(
    ModelClass: ModelConstructorLike
  ): (idArray: string[]) => unknown;
  getSchema(): Record<string, unknown>;
  registerFieldMappings(ModelClass: ModelConstructorLike): void;
  deletedError: Error;
  staleError: Error;
}

export const REVISION_FIELD_MAPPINGS = Object.freeze({
  _revID: '_rev_id',
  _revUser: '_rev_user',
  _revDate: '_rev_date',
  _revTags: '_rev_tags',
  _revDeleted: '_rev_deleted',
  _oldRevOf: '_old_rev_of',
});

const deletedError = new Error('Revision has been deleted.');
deletedError.name = 'RevisionDeletedError';
const staleError = new Error('Outdated revision.');
staleError.name = 'RevisionStaleError';

/**
 * Apply revision metadata to a model instance
 *
 * Ensures revision fields (_rev_id, _rev_user, _rev_date, _rev_tags) are
 * populated and tracked via the model's change set.
 *
 * @param instance - Model instance to stamp
 * @param options - Metadata options
 * @param [options.user] - User object providing the ID
 * @param [options.userId] - Explicit user ID (if user object omitted)
 * @param [options.date] - Revision timestamp (defaults to now)
 * @param [options.tags] - Revision tags
 * @param [options.revId] - Explicit revision ID (generated if absent)
 * @returns The same model instance for chaining
 */
const applyRevisionMetadata = (
  instance: ModelInstance,
  {
    user = null,
    userId = null,
    date = new Date(),
    tags = [],
    revId = null,
  }: {
    user?: { id?: string } | null;
    userId?: string | null;
    date?: Date | string;
    tags?: string[] | string | null;
    revId?: string | null;
  } = {}
): ModelInstance => {
  const resolvedUserId =
    user && typeof user === 'object' && 'id' in user && typeof user.id === 'string'
      ? user.id
      : userId;
  if (!resolvedUserId) {
    throw new ValidationError('Revision metadata requires a user ID');
  }

  const timestamp = date instanceof Date ? date : new Date(date);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new ValidationError('Revision metadata requires a valid date');
  }

  const resolvedTags = tags == null ? [] : Array.isArray(tags) ? [...tags] : [tags];
  const resolvedRevId = revId || randomUUID();

  instance._revID = resolvedRevId;
  instance._revUser = resolvedUserId;
  instance._revDate = timestamp;
  instance._revTags = resolvedTags;

  return instance;
};

/**
 * Revision system handlers
 */
const revision: RevisionHelpers = {
  applyRevisionMetadata,

  /**
   * Get a function that creates a new revision handler for PostgreSQL
   *
   * @param ModelClass - The model class
   * @returns New revision handler function
   */
  getNewRevisionHandler(ModelClass) {
    /**
     * Create a new revision by archiving the current revision and preparing
     * a new one with updated revision metadata
     *
     * @param user - User creating the revision
     * @param options - Revision options
     * @param options.tags - Tags to associate with revision
     * @returns New revision instance
     */
    const newRevision = async function (
      this: ModelInstance,
      user: { id?: string } | null,
      { tags }: { tags?: string[] } = {}
    ) {
      const currentRev = this;

      const oldRevData = { ...currentRev._data } as Record<string, unknown>;
      (oldRevData as Record<string, unknown>)._old_rev_of = currentRev.id;
      delete oldRevData.id;

      const insertFields = Object.keys(oldRevData).filter(key => oldRevData[key] !== undefined);
      const insertValues = insertFields.map(key => oldRevData[key]);
      const placeholders = insertFields.map((_, index) => `$${index + 1}`);

      const insertQuery = `
        INSERT INTO ${ModelClass.tableName} (${insertFields.join(', ')})
        VALUES (${placeholders.join(', ')})
      `;

      await ModelClass.dal.query(insertQuery, insertValues);

      const metadataDate = new Date();
      applyRevisionMetadata(currentRev, {
        user,
        userId: user?.id ?? null,
        date: metadataDate,
        tags,
      });

      return currentRev;
    };

    return newRevision;
  },

  /**
   * Get a function that handles deletion of all revisions
   *
   * @param ModelClass - The model class
   * @returns Delete all revisions handler
   */
  getDeleteAllRevisionsHandler(ModelClass) {
    /**
     * Mark all revisions as deleted by creating a deletion revision
     * and updating all related revisions
     *
     * @param user - User performing the deletion
     * @param options - Deletion options
     * @param options.tags - Tags for the deletion (will prepend 'delete')
     * @returns Deletion revision
     */
    const deleteAllRevisions = async function (
      this: ModelInstance,
      user: { id?: string } | null,
      { tags = [] }: { tags?: string[] } = {}
    ) {
      const id = this.id;
      const deletionTags = ['delete', ...tags];

      const rev = await this.newRevision(user, { tags: deletionTags });

      rev._revDeleted = true;

      await rev.save();

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
   * @param ModelClass - The model class
   * @returns Get handler for current revisions
   */
  getNotStaleOrDeletedGetHandler(ModelClass) {
    /**
     * Get a record by ID, ensuring it's not stale or deleted
     *
     * @param id - Record ID
     * @param joinOptions - Join options for related data
     * @returns Model instance
     * @throws If revision is deleted or stale
     */
    const getNotStaleOrDeleted = async function (
      this: ModelInstance,
      id: string,
      joinOptions: Record<string, unknown> = {}
    ) {
      // Validate UUID format before querying database to avoid PostgreSQL syntax errors
      if (!isUUID.v4(id)) {
        throw new InvalidUUIDError(`Invalid ${ModelClass.tableName} address format`);
      }

      let data: ModelInstance | null = null;

      if (Object.keys(joinOptions).length > 0) {
        const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);
        data = await query.filter({ id }).getJoin(joinOptions).first();
      } else {
        const queryText = `
          SELECT * FROM ${ModelClass.tableName}
          WHERE id = $1
        `;
        const result = await ModelClass.dal.query(queryText, [id]);
        data = result.rows[0] ? ModelClass._createInstance(result.rows[0]) : null;
      }

      if (!data) {
        throw new DocumentNotFound(`${ModelClass.tableName} with id ${id} not found`);
      }

      if (data._data._rev_deleted) {
        throw deletedError;
      }

      if (data._data._old_rev_of) {
        throw staleError;
      }

      return data;
    };

    return getNotStaleOrDeleted;
  },

  /**
   * Get a function that creates the first revision of a model
   *
   * @param ModelClass - The model class
   * @returns First revision creator
   */
  getFirstRevisionHandler(ModelClass) {
    /**
     * Create the first revision of a model instance
     *
     * @param user - User creating the first revision
     * @param options - Revision options
     * @param options.tags - Tags to associate with revision
     * @returns First revision instance
     */
    const createFirstRevision = async function (
      this: ModelInstance,
      user: { id?: string } | null,
      { tags, date = new Date() }: { tags?: string[]; date?: Date } = {}
    ) {
      const firstRev = new ModelClass({});
      applyRevisionMetadata(firstRev, {
        user,
        userId: user?.id ?? null,
        date,
        tags,
      });

      return firstRev;
    };

    return createFirstRevision;
  },

  /**
   * Get a function that filters records to exclude stale and deleted revisions
   *
   * @param ModelClass - The model class
   * @returns Filter function for current revisions
   */
  getNotStaleOrDeletedFilterHandler(ModelClass) {
    /**
     * Filter records to exclude stale and deleted revisions
     *
     * @returns Query builder with revision filters applied
     */
    const filterNotStaleOrDeleted = () => {
      const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);
      return query.filterNotStaleOrDeleted();
    };

    return filterNotStaleOrDeleted;
  },

  /**
   * Get a function that retrieves multiple records by IDs, excluding stale and deleted revisions
   *
   * @param ModelClass - The model class
   * @returns Multiple get handler for current revisions
   */
  getMultipleNotStaleOrDeletedHandler(ModelClass) {
    /**
     * Get multiple records by IDs, excluding stale and deleted revisions
     *
     * @param idArray - Array of record IDs
     * @returns Query builder for chaining
     */
    const getMultipleNotStaleOrDeleted = (idArray: string[]) => {
      const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);

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
   * @returns Schema fields for revision system
   */
  getSchema() {
    return {
      _revUser: types.string().uuid(4).required(true),
      _revDate: types.date().required(true),
      _revID: types.string().uuid(4).required(true),
      _oldRevOf: types.string().uuid(4),
      _revDeleted: types.boolean().default(false),
      _revTags: types.array(types.string()).default([]),
    };
  },

  /**
   * Register standard revision field aliases on a model so QueryBuilder
   * can keep using camelCase field names transparently in PostgreSQL.
   *
   * @param ModelClass - Model constructor returned by initializeModel
   */
  registerFieldMappings(ModelClass) {
    if (!ModelClass || typeof ModelClass._registerFieldMapping !== 'function') {
      return;
    }

    for (const [camel, snake] of Object.entries(REVISION_FIELD_MAPPINGS)) {
      ModelClass._registerFieldMapping(camel, snake);
    }
  },

  deletedError,
  staleError,
};

export { revision };

export default revision;
