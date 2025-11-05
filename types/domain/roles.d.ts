declare global {
  namespace LibReviews {
    type UserRole = 'anonymous' | 'member' | 'trusted' | 'site-moderator' | 'superuser';
  }
}

export type UserRole = LibReviews.UserRole;

export declare const USER_ROLES: readonly UserRole[];
