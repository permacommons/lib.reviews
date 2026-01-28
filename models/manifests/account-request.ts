import { randomUUID } from 'node:crypto';

import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';
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

export type AccountRequestRelations = {
  moderator?: UserView;
  inviteLink?: InviteLinkInstance;
};

export type AccountRequestInstanceMethodsMap = Record<never, never>;
export type AccountRequestInstance =
  ManifestInstance<typeof accountRequestManifest, AccountRequestInstanceMethodsMap> &
  AccountRequestRelations;

export type AccountRequestStaticMethodsMap = {
  getPending(): Promise<AccountRequestInstance[]>;
  getModerated(limit?: number): Promise<AccountRequestInstance[]>;
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
  }): Promise<AccountRequestInstance>;
};

type AccountRequestTypes = ManifestBundle<
  typeof accountRequestManifest,
  AccountRequestRelations,
  AccountRequestStaticMethodsMap,
  AccountRequestInstanceMethodsMap
>;
export type AccountRequestInstanceMethods = AccountRequestTypes['InstanceMethods'];
export type AccountRequestStaticMethods = AccountRequestTypes['StaticMethods'];
export type AccountRequestModel = AccountRequestTypes['Model'];

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
