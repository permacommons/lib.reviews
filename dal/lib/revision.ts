import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';

import QueryBuilder from './query-builder.js';
import { DocumentNotFound, InvalidUUIDError, ValidationError } from './errors.js';
import types from './type.js';

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
  applyRevisionMetadata(instance: ModelInstance, options?: {
    user?: { id?: string } | null;
    userId?: string | null;
    date?: Date | string;
    tags?: string[] | string | null;
    revId?: string | null;
  }): ModelInstance;
  getNewRevisionHandler(ModelClass: ModelConstructorLike): (this: ModelInstance, user: { id?: string } | null, options?: { tags?: string[] }) => Promise<ModelInstance>;
  getDeleteAllRevisionsHandler(ModelClass: ModelConstructorLike): (this: ModelInstance, user: { id?: string } | null, options?: { tags?: string[] }) => Promise<ModelInstance>;
  getNotStaleOrDeletedGetHandler(ModelClass: ModelConstructorLike): (this: ModelInstance, id: string, joinOptions?: Record<string, unknown>) => Promise<ModelInstance>;
  getFirstRevisionHandler(ModelClass: ModelConstructorLike): (this: ModelInstance, user: { id?: string } | null, options?: { tags?: string[]; date?: Date }) => Promise<ModelInstance>;
  getNotStaleOrDeletedFilterHandler(ModelClass: ModelConstructorLike): () => unknown;
  getMultipleNotStaleOrDeletedHandler(ModelClass: ModelConstructorLike): (idArray: string[]) => unknown;
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
  _oldRevOf: '_old_rev_of'
});

const deletedError = new Error('Revision has been deleted.');
deletedError.name = 'RevisionDeletedError';
const staleError = new Error('Outdated revision.');
staleError.name = 'RevisionStaleError';

const applyRevisionMetadata = (
  instance: ModelInstance,
  {
    user = null,
    userId = null,
    date = new Date(),
    tags = [],
    revId = null
  }: {
    user?: { id?: string } | null;
    userId?: string | null;
    date?: Date | string;
    tags?: string[] | string | null;
    revId?: string | null;
  } = {}
): ModelInstance => {
  const resolvedUserId = user && typeof user === 'object' && 'id' in user && typeof user.id === 'string'
    ? user.id
    : userId;
  if (!resolvedUserId) {
    throw new ValidationError('Revision metadata requires a user ID');
  }

  const timestamp = date instanceof Date ? date : new Date(date);
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
    throw new ValidationError('Revision metadata requires a valid date');
  }

  const resolvedTags = tags == null
    ? []
    : (Array.isArray(tags) ? [...tags] : [tags]);
  const resolvedRevId = revId || randomUUID();

  instance._rev_id = resolvedRevId;
  instance._rev_user = resolvedUserId;
  instance._rev_date = timestamp;
  instance._rev_tags = resolvedTags;

  return instance;
};

const revision: RevisionHelpers = {
  applyRevisionMetadata,

  getNewRevisionHandler(ModelClass) {
    const newRevision = async function(this: ModelInstance, user: { id?: string } | null, { tags }: { tags?: string[] } = {}) {
      const currentRev = this;

      const oldRevData = { ...currentRev._data } as Record<string, unknown>;
      (oldRevData as Record<string, unknown>)._old_rev_of = currentRev.id;
      delete oldRevData.id;

      const insertFields = Object.keys(oldRevData).filter((key) => oldRevData[key] !== undefined);
      const insertValues = insertFields.map((key) => oldRevData[key]);
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
        tags
      });

      return currentRev;
    };

    return newRevision;
  },

  getDeleteAllRevisionsHandler(ModelClass) {
    const deleteAllRevisions = async function(this: ModelInstance, user: { id?: string } | null, { tags = [] }: { tags?: string[] } = {}) {
      const id = this.id;
      const deletionTags = ['delete', ...tags];

      const rev = await this.newRevision(user, { tags: deletionTags });

      rev._data._rev_deleted = true;
      rev._changed.add('_rev_deleted');

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

  getNotStaleOrDeletedGetHandler(ModelClass) {
    const getNotStaleOrDeleted = async function(this: ModelInstance, id: string, joinOptions: Record<string, unknown> = {}) {
      if (!isUUID.v4(id)) {
        throw new InvalidUUIDError(`Invalid ${ModelClass.tableName} address format`);
      }

      let data: ModelInstance | null = null;

      if (Object.keys(joinOptions).length > 0) {
        const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);
        data = await query
          .filter({ id })
          .getJoin(joinOptions)
          .first();
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

  getFirstRevisionHandler(ModelClass) {
    const createFirstRevision = async function(this: ModelInstance, user: { id?: string } | null, { tags, date = new Date() }: { tags?: string[]; date?: Date } = {}) {
      const firstRev = new ModelClass({});
      applyRevisionMetadata(firstRev, {
        user,
        userId: user?.id ?? null,
        date,
        tags
      });

      return firstRev;
    };

    return createFirstRevision;
  },

  getNotStaleOrDeletedFilterHandler(ModelClass) {
    const filterNotStaleOrDeleted = function() {
      const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);
      return query.filterNotStaleOrDeleted();
    };

    return filterNotStaleOrDeleted;
  },

  getMultipleNotStaleOrDeletedHandler(ModelClass) {
    const getMultipleNotStaleOrDeleted = function(idArray: string[]) {
      const query = new (QueryBuilder as any)(ModelClass, ModelClass.dal);

      if (idArray.length > 0) {
        query.whereIn('id', idArray, { cast: 'uuid[]' });
      }

      return query.filterNotStaleOrDeleted();
    };

    return getMultipleNotStaleOrDeleted;
  },

  getSchema() {
    return {
      _rev_user: types.string().uuid(4).required(true),
      _rev_date: types.date().required(true),
      _rev_id: types.string().uuid(4).required(true),
      _old_rev_of: types.string().uuid(4),
      _rev_deleted: types.boolean().default(false),
      _rev_tags: types.array(types.string()).default([])
    };
  },

  registerFieldMappings(ModelClass) {
    if (!ModelClass || typeof ModelClass._registerFieldMapping !== 'function') {
      return;
    }

    for (const [camel, snake] of Object.entries(REVISION_FIELD_MAPPINGS)) {
      ModelClass._registerFieldMapping(camel, snake);
    }
  },

  deletedError,
  staleError
};

export { revision };

export default revision;
