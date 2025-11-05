declare global {
  namespace LibReviews {
    type PermissionKey =
      | 'add'
      | 'blog'
      | 'delete'
      | 'edit'
      | 'edit-metadata'
      | 'join'
      | 'leave'
      | 'upload'
      | 'upload-temp-files';

    type PermissionFlag =
      | 'userCanAdd'
      | 'userCanBlog'
      | 'userCanDelete'
      | 'userCanEdit'
      | 'userCanEditMetadata'
      | 'userCanJoin'
      | 'userCanLeave'
      | 'userCanUpload'
      | 'userCanUploadTempFiles';
  }
}

export type PermissionKey = LibReviews.PermissionKey;
export type PermissionFlag = LibReviews.PermissionFlag;

export declare const PERMISSION_FLAGS: readonly PermissionFlag[];
