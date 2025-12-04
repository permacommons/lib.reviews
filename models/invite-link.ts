import config from 'config';
import isUUID from 'is-uuid';

import { defineModel, defineStaticMethods } from '../dal/lib/create-model.ts';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import debug from '../util/debug.ts';
import { referenceAccountRequest } from './manifests/account-request.ts';
import inviteLinkManifest, {
  type InviteLinkInstance,
  type InviteLinkInstanceMethods,
  type InviteLinkModel,
  type InviteLinkStaticMethods,
} from './manifests/invite-link.ts';
import { referenceUser, type UserView } from './manifests/user.ts';

const User = referenceUser();
const AccountRequest = referenceAccountRequest();

const inviteLinkStaticMethods = defineStaticMethods(inviteLinkManifest, {
  /**
   * Get pending invite links created by the given user (excludes account request links).
   *
   * @param user - User whose pending invites to load
   * @returns Pending invite links, newest first
   */
  async getAvailable(user: { id?: string }) {
    if (!user || !user.id) {
      return [];
    }

    try {
      // Get all account request invite link IDs by this user to exclude them
      const accountRequests = await AccountRequest.filterWhere({
        moderatedBy: user.id,
        inviteLinkID: AccountRequest.ops.neq(null),
      }).run();

      const accountRequestLinkIDs = accountRequests
        .map(req => req.inviteLinkID)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      // Get all invites created by user that are unused and not in the account request list
      let query = this.filterWhere({ createdBy: user.id, usedBy: null });

      if (accountRequestLinkIDs.length > 0) {
        query = query.and({
          id: this.ops.notIn(accountRequestLinkIDs as [string, ...string[]]),
        });
      }

      const invites = await query.orderBy('createdOn', 'DESC').run();

      return invites.map(normalizeInviteInstance);
    } catch (error) {
      debug.error('Failed to fetch pending invite links:', error);
      return [];
    }
  },

  /**
   * Get redeemed invite links created by the given user (excludes account request links), including user info.
   *
   * @param user - User whose redeemed invites to load
   * @returns Redeemed invite links, newest first
   */
  async getUsed(user: { id?: string }) {
    if (!user || !user.id) {
      return [];
    }

    try {
      // Get all account request invite link IDs by this user to exclude them
      const accountRequests = await AccountRequest.filterWhere({
        moderatedBy: user.id,
        inviteLinkID: AccountRequest.ops.neq(null),
      }).run();

      const accountRequestLinkIDs = accountRequests
        .map(req => req.inviteLinkID)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      // Get all used invites excluding account request links
      let query = this.filterWhere({ createdBy: user.id, usedBy: this.ops.neq(null) });

      if (accountRequestLinkIDs.length > 0) {
        query = query.and({
          id: this.ops.notIn(accountRequestLinkIDs as [string, ...string[]]),
        });
      }

      const invites = await query.orderBy('createdOn', 'DESC').run();

      invites.forEach(normalizeInviteInstance);

      const usedByIds = [
        ...new Set(
          invites
            .map(invite => invite.usedBy)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        ),
      ];
      if (usedByIds.length === 0) {
        return invites;
      }

      const users = await User.fetchView<UserView>('publicProfile', {
        configure(builder) {
          builder.whereIn('id', usedByIds, { cast: 'uuid[]' });
        },
      });
      const userMap = new Map<string, UserView>();
      users.forEach(user => {
        if (user.id) {
          userMap.set(user.id, user);
        }
      });

      invites.forEach(invite => {
        if (invite.usedBy && userMap.has(invite.usedBy)) {
          invite.usedByUser = userMap.get(invite.usedBy);
        }
      });

      return invites;
    } catch (error) {
      debug.error('Failed to fetch redeemed invite links:', error);
      return [];
    }
  },

  /**
   * Get invite links created for account requests by the given user.
   *
   * @param user - User whose account request invites to load
   * @returns Account request invite links, newest first
   */
  async getAccountRequestLinks(user: { id?: string }) {
    if (!user || !user.id) {
      return [];
    }

    try {
      // Get all account requests that have invite links created by this user
      const accountRequests = await AccountRequest.filterWhere({
        moderatedBy: user.id,
        inviteLinkID: AccountRequest.ops.neq(null),
      })
        .includeSensitive(['email'])
        .orderBy('moderatedAt', 'DESC')
        .run();

      if (accountRequests.length === 0) {
        return [];
      }

      // Extract the invite link IDs
      const inviteLinkIDs = accountRequests
        .map(req => req.inviteLinkID)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      if (inviteLinkIDs.length === 0) {
        return [];
      }

      // Fetch all those invite links
      const invites = await this.filterWhere({
        id: this.ops.in(inviteLinkIDs as [string, ...string[]]),
      })
        .orderBy('createdOn', 'DESC')
        .run();

      invites.forEach(normalizeInviteInstance);

      // If any are used, fetch the user info
      const usedByIds = [
        ...new Set(
          invites
            .map(invite => invite.usedBy)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        ),
      ];

      if (usedByIds.length > 0) {
        const users = await User.fetchView<UserView>('publicProfile', {
          configure(builder) {
            builder.whereIn('id', usedByIds, { cast: 'uuid[]' });
          },
        });
        const userMap = new Map<string, UserView>();
        users.forEach(user => {
          if (user.id) {
            userMap.set(user.id, user);
          }
        });

        invites.forEach(invite => {
          if (invite.usedBy && userMap.has(invite.usedBy)) {
            invite.usedByUser = userMap.get(invite.usedBy);
          }
        });
      }

      return invites;
    } catch (error) {
      debug.error('Failed to fetch account request invite links:', error);
      return [];
    }
  },

  /**
   * Fetch a single invite link by its identifier.
   *
   * @param id - Invite link identifier (UUID)
   * @returns Invite link instance
   * @throws DocumentNotFound when no invite with the provided id exists
   */
  async get(id: string) {
    if (!id) {
      const error = new DocumentNotFound('Invite link not found');
      error.name = 'DocumentNotFoundError';
      throw error;
    }

    if (!isUUID.v4(id)) {
      const error = new DocumentNotFound(`invite_links with id ${id} not found`);
      error.name = 'DocumentNotFoundError';
      throw error;
    }

    try {
      const invite = await this.filterWhere({ id }).first();
      if (!invite) {
        const error = new DocumentNotFound(`invite_links with id ${id} not found`);
        error.name = 'DocumentNotFoundError';
        throw error;
      }

      return normalizeInviteInstance(invite);
    } catch (error) {
      if (error instanceof DocumentNotFound || (error as Error).name === 'DocumentNotFoundError') {
        throw error;
      }
      debug.error('Failed to fetch invite link by id:', error);
      throw error;
    }
  },
}) satisfies InviteLinkStaticMethods;

const InviteLink = defineModel(inviteLinkManifest, {
  staticMethods: inviteLinkStaticMethods,
}) as InviteLinkModel;

export default InviteLink;
export type {
  InviteLinkInstance,
  InviteLinkInstanceMethods,
  InviteLinkModel,
  InviteLinkStaticMethods,
} from './manifests/invite-link.ts';

/**
 * Build the canonical registration URL for an invite link instance.
 *
 * @param invite - Invite link instance or plain object
 * @returns Fully qualified invite URL
 */
function buildInviteURL(
  invite: InviteLinkInstance | ModelInstance | null | undefined
): string | undefined {
  if (!invite) {
    return undefined;
  }
  const identifier = invite.id;
  return identifier ? `${config.qualifiedURL}register/${identifier}` : undefined;
}

/**
 * Normalize fields on a hydrated invite link instance.
 *
 * @param invite - Invite link instance
 * @returns The normalized invite instance
 */
function normalizeInviteInstance(invite: InviteLinkInstance): InviteLinkInstance {
  if (!invite) {
    return invite;
  }
  invite.url = buildInviteURL(invite);
  return invite;
}
