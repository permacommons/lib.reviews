import dal from 'rev-dal';
import type {
  InstanceMethodsFrom,
  ManifestInstance,
  ManifestModel,
  StaticMethodsFrom,
} from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';
import type { ThingInstance } from './thing.ts';
import type { UserAccessContext, UserView } from './user.ts';

const { mlString, types } = dal;
const validLicenseValues = ['cc-0', 'cc-by', 'cc-by-sa', 'fair-use'] as const;

const fileManifest = {
  tableName: 'files',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    name: types.string().max(512),
    description: mlString.getSafeTextSchema(),
    uploadedBy: types.string().uuid(4),
    uploadedOn: types.date(),
    mimeType: types.string(),
    license: types.string().enum(Array.from(validLicenseValues)),
    creator: mlString.getSafeTextSchema(),
    source: mlString.getSafeTextSchema(),
    completed: types.boolean().default(false),
    userCanDelete: types.virtual().default(false),
    userIsCreator: types.virtual().default(false),

    // Note: relation fields (uploader, things) are typed via intersection pattern
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
  ],
} as const satisfies ModelManifest;

export interface FileFeedOptions {
  offsetDate?: Date;
  limit?: number;
}

export interface FileFeedResult<TItem> {
  items: TItem[];
  offsetDate?: Date;
}

export type FileRelations = { uploader?: UserView; things?: ThingInstance[] };

export type FileInstanceMethodsMap = {
  populateUserInfo(user: UserAccessContext | null | undefined): void;
};
export type FileInstanceMethods = InstanceMethodsFrom<
  typeof fileManifest,
  FileInstanceMethodsMap,
  FileRelations
>;
export type FileInstance =
  ManifestInstance<typeof fileManifest, FileInstanceMethods> & FileRelations;

export type FileStaticMethodsMap = {
  getStashedUpload(userID: string, name: string): Promise<FileInstance | undefined>;
  getValidLicenses(): readonly string[];
  getFileFeed(options?: FileFeedOptions): Promise<FileFeedResult<FileInstance>>;
};
export type FileStaticMethods = StaticMethodsFrom<
  typeof fileManifest,
  FileStaticMethodsMap,
  FileInstanceMethods,
  FileRelations
>;
export type FileModel = ManifestModel<typeof fileManifest, FileStaticMethods, FileInstanceMethods>;
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
