import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';
import { DocumentNotFound, InvalidUUIDError, ValidationError } from './errors.ts';
import type {
  FilterWhereQueryBuilder,
  JsonObject,
  RevisionActor,
  VersionedModelConstructor,
  VersionedModelInstance,
} from './model-types.ts';
import type { JoinOptions } from './query-builder.ts';
import types from './type.ts';

/**
 * Revision system handlers for PostgreSQL DAL
 *
 * Provides revision management functionality leveraging PostgreSQL
 * features like partial indexes for performance.
 */

export interface ModelConstructorLike<
  TData extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends VersionedModelInstance<TData, TVirtual> = VersionedModelInstance<
    TData,
    TVirtual
  >,
> extends VersionedModelConstructor<TData, TVirtual, TInstance> {
  _createInstance(row: JsonObject): TInstance;
  _registerFieldMapping?(camel: string, snake: string): void;
}

type FilterWhereCapable<
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends VersionedModelInstance<TData, TVirtual>,
> = {
  filterWhere?: (
    literal: JsonObject
  ) => FilterWhereQueryBuilder<TData, TVirtual, TInstance, string>;
};

export interface RevisionHelpers {
  applyRevisionMetadata<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(
    instance: TInstance,
    options?: {
      user?: RevisionActor | null;
      date?: Date | string;
      tags?: string[] | string | null;
      revId?: string | null;
    }
  ): TInstance;
  getNewRevisionHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(
    ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>
  ): (
    this: TInstance,
    user: RevisionActor | null,
    options?: { tags?: string[] }
  ) => Promise<VersionedModelInstance<TData, TVirtual>>;
  getDeleteAllRevisionsHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(
    ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>
  ): (
    this: TInstance,
    user: RevisionActor | null,
    options?: { tags?: string[] }
  ) => Promise<VersionedModelInstance<TData, TVirtual>>;
  getNotStaleOrDeletedGetHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(
    ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>
  ): (id: string, joinOptions?: JoinOptions) => Promise<VersionedModelInstance<TData, TVirtual>>;
  getFirstRevisionHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(
    ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>
  ): (
    this: TInstance,
    user: RevisionActor | null,
    options?: { tags?: string[]; date?: Date }
  ) => Promise<VersionedModelInstance<TData, TVirtual>>;
  getMultipleNotStaleOrDeletedHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>): (idArray: string[]) => unknown;
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

type RevisionUserInput = RevisionActor | null | undefined;

const resolveRevisionUserId = (user: RevisionUserInput): string | null => {
  if (!user) {
    return null;
  }

  return user.id;
};

/**
 * Apply revision metadata to a model instance
 *
 * Ensures revision fields (_rev_id, _rev_user, _rev_date, _rev_tags) are
 * populated and tracked via the model's change set.
 *
 * @param instance - Model instance to stamp
 * @param options - Metadata options
 * @param [options.user] - User object providing the ID
 * @param [options.date] - Revision timestamp (defaults to now)
 * @param [options.tags] - Revision tags
 * @param [options.revId] - Explicit revision ID (generated if absent)
 * @returns The same model instance for chaining
 */
const applyRevisionMetadata = <
  TData extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends VersionedModelInstance<TData, TVirtual>,
>(
  instance: TInstance,
  {
    user = null,
    date = new Date(),
    tags = [],
    revId = null,
  }: {
    user?: RevisionActor | null;
    date?: Date | string;
    tags?: string[] | string | null;
    revId?: string | null;
  } = {}
): TInstance => {
  const resolvedUserId = resolveRevisionUserId(user);
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
  getNewRevisionHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>) {
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
      this: TInstance,
      user: RevisionActor | null,
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
      applyRevisionMetadata<TData, TVirtual, TInstance>(currentRev, {
        user,
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
  getDeleteAllRevisionsHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>) {
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
      this: TInstance,
      user: RevisionActor | null,
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
  getNotStaleOrDeletedGetHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>) {
    /**
     * Get a record by ID, ensuring it's not stale or deleted
     *
     * @param id - Record ID
     * @param joinOptions - Join options for related data
     * @returns Model instance
     * @throws If revision is deleted or stale
     */
    const getNotStaleOrDeleted = async (id: string, joinOptions: JoinOptions = {}) => {
      // Validate UUID format before querying database to avoid PostgreSQL syntax errors
      if (!isUUID.v4(id)) {
        throw new InvalidUUIDError(`Invalid ${ModelClass.tableName} address format`);
      }

      const filterWhere = (ModelClass as FilterWhereCapable<TData, TVirtual, TInstance>)
        .filterWhere;
      if (typeof filterWhere !== 'function') {
        throw new Error(
          `Model "${ModelClass.tableName}" must expose filterWhere. Ensure defineModel() initialized this constructor.`
        );
      }

      const builder = filterWhere
        .call(ModelClass, {} as JsonObject)
        .includeDeleted()
        .includeStale();
      const idField = 'id' as Extract<keyof TData, string>;
      builder.whereIn(idField, [id], { cast: 'uuid[]' });

      if (Object.keys(joinOptions).length > 0) {
        builder.getJoin(joinOptions as never);
      }

      const data = (await builder.first()) as TInstance | null;

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
  getFirstRevisionHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>) {
    /**
     * Create the first revision of a model instance
     *
     * @param user - User creating the first revision
     * @param options - Revision options
     * @param options.tags - Tags to associate with revision
     * @returns First revision instance
     */
    const createFirstRevision = async function (
      this: TInstance,
      user: RevisionActor | null,
      { tags, date = new Date() }: { tags?: string[]; date?: Date } = {}
    ) {
      const firstRev = new ModelClass({}) as TInstance;
      applyRevisionMetadata<TData, TVirtual, TInstance>(firstRev, { user, date, tags });

      return firstRev;
    };

    return createFirstRevision;
  },

  /**
   * Get a function that retrieves multiple records by IDs, excluding stale and deleted revisions
   *
   * @param ModelClass - The model class
   * @returns Multiple get handler for current revisions
   */
  getMultipleNotStaleOrDeletedHandler<
    TData extends JsonObject,
    TVirtual extends JsonObject,
    TInstance extends VersionedModelInstance<TData, TVirtual>,
  >(ModelClass: ModelConstructorLike<TData, TVirtual, TInstance>) {
    /**
     * Get multiple records by IDs, excluding stale and deleted revisions
     *
     * @param idArray - Array of record IDs
     * @returns Query builder for chaining
     */
    const getMultipleNotStaleOrDeleted = (ids: string[]) => {
      const filterWhere = (ModelClass as FilterWhereCapable<TData, TVirtual, TInstance>)
        .filterWhere;

      if (typeof filterWhere !== 'function') {
        throw new Error(
          `Model "${ModelClass.tableName}" must expose filterWhere. Ensure defineModel() initialized this constructor.`
        );
      }

      const builder = filterWhere.call(ModelClass, {} as JsonObject);
      const idField = 'id' as Extract<keyof TData, string>;

      if (ids.length > 0) {
        builder.whereIn(idField, ids, { cast: 'uuid[]' });
      } else {
        builder.limit(0);
      }

      return builder;
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

export default revision;
