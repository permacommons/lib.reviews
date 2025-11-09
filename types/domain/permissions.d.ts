declare global {
  namespace LibReviews {
    /**
     * Permission slugs that mirror the capability fields generated on models
     * such as `Team` and `Thing` via `userCan*` virtuals. They describe the
     * discrete actions surfaced in the UI.
     */
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

    /**
     * Boolean flags hydrated onto `RequestUser.permissions` and `res.locals`
     * for templates to check when toggling UI affordances
     * (see `types/http/locals.ts`).
     */
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

/**
 * Convenience list of permission flags used when shaping template locals and
 * express responses.
 */
export declare const PERMISSION_FLAGS: readonly PermissionFlag[];
