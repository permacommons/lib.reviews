import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import fileManifest, {
  type FileFeedOptions,
  type FileFeedResult,
  type FileInstance,
  type FileInstanceMethods,
  type FileModel,
  type FileStaticMethods,
  fileValidLicenses,
} from './manifests/file.ts';
import type { UserViewer } from './user.ts';

const validLicenses = fileValidLicenses;

const fileStaticMethods = defineStaticMethods(fileManifest, {
  /**
   * Get a stashed (incomplete) upload by user ID and name.
   *
   * @param userID - User identifier that created the upload
   * @param name - File name used during the staged upload
   * @returns File instance for the pending upload, if present
   */
  async getStashedUpload(this: FileModel, userID: string, name: string) {
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
      ? (this.createFromRow(result.rows[0] as Record<string, unknown>) as FileInstance)
      : undefined;
  },

  /**
   * Get array of valid license values.
   *
   * @returns Clone of the allowed license identifiers
   */
  getValidLicenses(this: FileModel): readonly string[] {
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
  async getFileFeed(
    this: FileModel,
    { offsetDate, limit = 10 }: FileFeedOptions = {}
  ): Promise<FileFeedResult<Record<string, any>>> {
    let query = this.filterWhere({ completed: true })
      .getJoin({ uploader: true })
      .orderBy('uploadedOn', 'DESC');

    if (offsetDate?.valueOf) {
      query = query.and({ uploadedOn: this.ops.lt(offsetDate) });
    }

    const items = await query.limit(limit + 1).run();
    const slicedItems = items.slice(0, limit);

    const feed: FileFeedResult<Record<string, any>> = {
      items: slicedItems,
    };

    if (items.length === limit + 1 && limit > 0) {
      const lastVisible = slicedItems[limit - 1] as { uploadedOn?: Date };
      feed.offsetDate = lastVisible?.uploadedOn;
    }

    return feed;
  },
}) satisfies FileStaticMethods;

const fileInstanceMethods = defineInstanceMethods(fileManifest, {
  /**
   * Populate virtual permission fields in a File instance for the given user.
   *
   * @param user - User whose permissions should be evaluated
   */
  populateUserInfo(this: FileInstance, user: UserViewer | null | undefined) {
    if (!user) {
      return;
    }

    const isSuperUser = Boolean(user.isSuperUser);
    const isSiteModerator = Boolean(user.isSiteModerator);

    this.userIsCreator = user.id === this.uploadedBy;
    this.userCanDelete = this.userIsCreator || isSuperUser || isSiteModerator;
  },
}) satisfies FileInstanceMethods;

const File = defineModel(fileManifest, {
  statics: {
    validLicenses,
  },
  staticMethods: fileStaticMethods,
  instanceMethods: fileInstanceMethods,
}) as FileModel;

export { fileManifest };
export default File;
export type {
  FileFeedOptions,
  FileFeedResult,
  FileInstance,
  FileInstanceMethods,
  FileModel,
  FileStaticMethods,
};
