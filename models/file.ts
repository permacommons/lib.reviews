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
import type { UserAccessContext } from './user.ts';

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
    const stashedUpload = (await this.filterWhere({
      name,
      uploadedBy: userID,
      completed: false,
    }).first()) as FileInstance | null;
    return stashedUpload ?? undefined;
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
  ): Promise<FileFeedResult<FileInstance>> {
    const feedPage = await this.filterWhere({ completed: true })
      .getJoin({ uploader: true })
      .chronologicalFeed({ cursorField: 'uploadedOn', cursor: offsetDate ?? undefined, limit });

    // Cast required: query builder returns base instance type, but runtime
    // attaches instance methods defined in the manifest.
    return {
      items: feedPage.rows as FileInstance[],
      offsetDate: feedPage.hasMore ? feedPage.nextCursor : undefined,
    };
  },
}) satisfies FileStaticMethods;

const fileInstanceMethods = defineInstanceMethods(fileManifest, {
  /**
   * Populate virtual permission fields in a File instance for the given user.
   *
   * @param user - User whose permissions should be evaluated
   */
  populateUserInfo(this: FileInstance, user: UserAccessContext | null | undefined) {
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
