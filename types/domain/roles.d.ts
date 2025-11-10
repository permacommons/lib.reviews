declare global {
  namespace LibReviews {
    /**
     * User roles understood by the authorization layer. These states are
     * derived from the boolean flags populated on `RequestUser` instances and
     * govern which actions the UI enables.
     */
    type UserRole = 'anonymous' | 'member' | 'trusted' | 'site-moderator' | 'superuser';
  }
}

export type UserRole = LibReviews.UserRole;

/**
 * Ordered list of user roles exposed by the locales helper when presenting
 * choices such as reviewer capabilities or moderation status.
 */
export declare const USER_ROLES: readonly UserRole[];
