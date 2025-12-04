import { randomUUID } from 'node:crypto';

import dal from '../../dal/index.ts';
import type { ManifestExports } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';
import type { InviteLinkInstance, InviteLinkModel } from './invite-link.ts';
import { referenceInviteLink } from './invite-link.ts';
import type { UserModel, UserView } from './user.ts';
import { referenceUser } from './user.ts';

const { types } = dal;

export type AccountRequestStatus = 'pending' | 'approved' | 'rejected';

const accountRequestManifest = {
  tableName: 'account_requests',
  hasRevisions: false as const,
  schema: {
    id: types
      .string()
      .uuid(4)
      .default(() => randomUUID()),
    plannedReviews: types.string().required(true),
    languages: types.string().required(true),
    aboutLinks: types.string().required(true),
    email: types.string().max(128).required(true).sensitive(),
    language: types.string().max(10).default('en'),
    termsAccepted: types.boolean().default(true),
    createdAt: types.date().default(() => new Date()),
    ipAddress: types.string().max(64),
    status: types.string().default('pending'),
    moderatedBy: types.string().uuid(4),
    moderatedAt: types.date(),
    rejectionReason: types.string(),
    inviteLinkID: types.string().uuid(4),
  },
  camelToSnake: {
    plannedReviews: 'planned_reviews',
    aboutLinks: 'about_links',
    termsAccepted: 'terms_accepted',
    createdAt: 'created_at',
    ipAddress: 'ip_address',
    moderatedBy: 'moderated_by',
    moderatedAt: 'moderated_at',
    rejectionReason: 'rejection_reason',
    inviteLinkID: 'invite_link_id',
  },
  relations: [
    {
      name: 'moderator',
      targetTable: 'users',
      sourceKey: 'moderatedBy',
      targetKey: 'id',
      hasRevisions: false,
      cardinality: 'one',
    },
    {
      name: 'inviteLink',
      targetTable: 'invite_links',
      sourceKey: 'inviteLinkID',
      targetKey: 'id',
      hasRevisions: false,
      cardinality: 'one',
    },
  ],
} as const satisfies ModelManifest;

type AccountRequestTypes = ManifestExports<
  typeof accountRequestManifest,
  {
    relations: {
      moderator?: UserView;
      inviteLink?: InviteLinkInstance;
    };
    statics: {
      getPending(): Promise<AccountRequestTypes['Instance'][]>;
      getModerated(limit?: number): Promise<AccountRequestTypes['Instance'][]>;
      hasRecentRequest(email: string, cooldownHours: number): Promise<boolean>;
      checkIPRateLimit(
        ipAddress: string | undefined,
        maxRequests: number,
        windowHours: number
      ): Promise<boolean>;
      createRequest(data: {
        plannedReviews: string;
        languages: string;
        aboutLinks: string;
        email: string;
        language: string;
        termsAccepted: boolean;
        ipAddress?: string;
      }): Promise<AccountRequestTypes['Instance']>;
    };
  }
>;

export type AccountRequestInstance = AccountRequestTypes['Instance'];
export type AccountRequestModel = AccountRequestTypes['Model'];
export type AccountRequestStaticMethods = AccountRequestTypes['StaticMethods'];

/**
 * Lazy references to related models to avoid circular imports.
 */
export function referenceAccountRequest(): AccountRequestModel {
  return referenceModel(accountRequestManifest) as AccountRequestModel;
}

/**
 * Get a lazy reference to the User model for account request moderators.
 *
 * @returns User model reference
 */
export function referenceAccountRequestModerator(): UserModel {
  return referenceUser();
}

/**
 * Get a lazy reference to the InviteLink model for account request invite links.
 *
 * @returns InviteLink model reference
 */
export function referenceAccountRequestInviteLink(): InviteLinkModel {
  return referenceInviteLink();
}

export default accountRequestManifest;
