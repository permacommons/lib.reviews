import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';
import type { UserViewer } from './user.ts';

const { mlString } = dal as { mlString: Record<string, any> };
const validLicenseValues = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'] as const;

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
    license: types.string().enum(Array.from(validLicenseValues)),
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
});

export interface FileFeedOptions {
  offsetDate?: Date;
  limit?: number;
}

export interface FileFeedResult<TItem> {
  items: TItem[];
  offsetDate?: Date;
}

type FileInstanceBase = InferInstance<typeof fileManifest>;
type FileModelBase = InferConstructor<typeof fileManifest>;

export interface FileInstanceMethods {
  populateUserInfo(
    this: FileInstanceBase & FileInstanceMethods,
    user: UserViewer | null | undefined
  ): void;
}

export interface FileStaticMethods {
  getStashedUpload(
    this: FileModelBase & FileStaticMethods,
    userID: string,
    name: string
  ): Promise<FileInstance | undefined>;
  getValidLicenses(this: FileModelBase & FileStaticMethods): readonly string[];
  getFileFeed(
    this: FileModelBase & FileStaticMethods,
    options?: FileFeedOptions
  ): Promise<FileFeedResult<Record<string, any>>>;
}

export type FileInstance = FileInstanceBase & FileInstanceMethods;
export type FileModel = FileModelBase & FileStaticMethods;
export const fileValidLicenses = validLicenseValues;

/**
 * Create a lazy reference to the File model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed File model constructor
 */
export function referenceFile(): FileModel {
  return referenceModel(fileManifest) as FileModel;
}

export default fileManifest;
