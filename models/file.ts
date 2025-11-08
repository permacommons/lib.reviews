import dal from '../dal/index.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import types from '../dal/lib/type.ts';

const { mlString } = dal as {
  mlString: Record<string, any>;
};

const validLicenses = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'] as const;

interface FileFeedOptions {
  offsetDate?: Date;
  limit?: number;
}

interface FileFeedResult<TItem> {
  items: TItem[];
  offsetDate?: Date;
}

const fileManifest = defineModelManifest({
  tableName: 'files',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),
    name: types.string().max(512),
    description: mlString.getSchema(),
    uploadedBy: types.string().uuid(4),
    uploadedOn: types.date(),
    mimeType: types.string(),
    license: types.string().enum(Array.from(validLicenses)),
    creator: mlString.getSchema(),
    source: mlString.getSchema(),
    completed: types.boolean().default(false),
    userCanDelete: types.virtual().default(false),
    userIsCreator: types.virtual().default(false),
  },
  camelToSnake: {
    uploadedBy: 'uploaded_by',
    uploadedOn: 'uploaded_on',
    mimeType: 'mime_type',
  },
  relations: [
    {
      name: 'uploader',
      targetTable: 'users',
      sourceKey: 'uploaded_by',
      targetKey: 'id',
      hasRevisions: false,
      cardinality: 'one',
    },
    {
      name: 'things',
      targetTable: 'things',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'thing_files',
        sourceForeignKey: 'file_id',
        targetForeignKey: 'thing_id',
      },
      cardinality: 'many',
    },
  ] as const,
  staticMethods: {
    /**
     * Get a stashed (incomplete) upload by user ID and name.
     *
     * @param userID - User identifier that created the upload
     * @param name - File name used during the staged upload
     * @returns File instance for the pending upload, if present
     */
    async getStashedUpload(userID: string, name: string) {
      const query = `
        SELECT *
        FROM ${this.tableName}
        WHERE name = $1
          AND uploaded_by = $2
          AND completed = false
          AND (_rev_deleted IS NULL OR _rev_deleted = false)
          AND (_old_rev_of IS NULL)
        LIMIT 1
      `;

      const result = await this.dal.query(query, [name, userID]);
      return result.rows.length > 0
        ? this.createFromRow(result.rows[0] as Record<string, unknown>)
        : undefined;
    },

    /**
     * Get array of valid license values.
     *
     * @returns Clone of the allowed license identifiers
     */
    getValidLicenses(): readonly string[] {
      return Array.from(validLicenses);
    },

    /**
     * Get a feed of completed files with pagination.
     *
     * @param options - Feed retrieval options
     * @param options.offsetDate - Upper bound for the returned results
     * @param options.limit - Maximum number of items requested
     * @returns Feed payload containing items and optional offset marker
     */
    async getFileFeed({ offsetDate, limit = 10 }: FileFeedOptions = {}) {
      let query = this.filter({ completed: true })
        .filterNotStaleOrDeleted()
        .getJoin({ uploader: true })
        .orderBy('uploadedOn', 'DESC');

      if (offsetDate && offsetDate.valueOf) {
        query = query.filter(row => row('uploadedOn').lt(offsetDate));
      }

      const items = await query.limit(limit + 1).run();
      const slicedItems = items.slice(0, limit);

      const feed: FileFeedResult<unknown> = {
        items: slicedItems,
      };

      if (items.length === limit + 1 && limit > 0) {
        const lastVisible = slicedItems[limit - 1] as { uploadedOn?: Date };
        feed.offsetDate = lastVisible?.uploadedOn;
      }

      return feed;
    },
  },
  instanceMethods: {
    /**
     * Populate virtual permission fields in a File instance for the given user.
     *
     * @param user - User whose permissions should be evaluated
     */
    populateUserInfo(user: Record<string, any>) {
      if (!user) {
        return;
      }

      this.userIsCreator = user.id === this.uploadedBy;
      this.userCanDelete = this.userIsCreator || user.isSuperUser || user.isSiteModerator || false;
    },
  },
} as const);

export type FileInstance = InferInstance<typeof fileManifest>;
export type FileModel = InferConstructor<typeof fileManifest>;

const File = defineModel(fileManifest, {
  statics: {
    validLicenses,
  },
});

export default File;
