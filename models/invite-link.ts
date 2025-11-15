import config from 'config';
import isUUID from 'is-uuid';

import { defineModel, defineStaticMethods } from '../dal/lib/create-model.ts';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import debug from '../util/debug.ts';
import inviteLinkManifest, {
  type InviteLinkInstance,
  type InviteLinkInstanceMethods,
  type InviteLinkModel,
  type InviteLinkStaticMethods,
} from './manifests/invite-link.ts';
import { referenceUser, type UserView } from './manifests/user.ts';

const User = referenceUser();

const inviteLinkStaticMethods = defineStaticMethods(inviteLinkManifest, {
  /**
   * Get pending invite links created by the given user.
   *
   * @param user - User whose pending invites to load
   * @returns Pending invite links, newest first
   */
  async getAvailable(this: InviteLinkModel, user: { id?: string }) {
    if (!user || !user.id) {
      return [];
    }

    try {
      const query = `
        SELECT *
        FROM ${this.tableName}
        WHERE created_by = $1
          AND (used_by IS NULL)
        ORDER BY created_on DESC
      `;

      const result = await this.dal.query(query, [user.id]);
      return result.rows.map(row =>
        normalizeInviteInstance(this.createFromRow(row as Record<string, unknown>))
      );
    } catch (error) {
      debug.error('Failed to fetch pending invite links:', error);
      return [];
    }
  },

  /**
   * Get redeemed invite links created by the given user, including user info.
   *
   * @param user - User whose redeemed invites to load
   * @returns Redeemed invite links, newest first
   */
  async getUsed(this: InviteLinkModel, user: { id?: string }) {
    if (!user || !user.id) {
      return [];
    }

    try {
      const query = `
        SELECT *
        FROM ${this.tableName}
        WHERE created_by = $1
          AND used_by IS NOT NULL
        ORDER BY created_on DESC
      `;

      const result = await this.dal.query(query, [user.id]);
      const invites = result.rows.map(row =>
        normalizeInviteInstance(this.createFromRow(row as Record<string, unknown>))
      );

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
   * Fetch a single invite link by its identifier.
   *
   * @param id - Invite link identifier (UUID)
   * @returns Invite link instance
   * @throws DocumentNotFound when no invite with the provided id exists
   */
  async get(this: InviteLinkModel, id: string) {
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
      const query = `
        SELECT *
        FROM ${this.tableName}
        WHERE id = $1
        LIMIT 1
      `;

      const result = await this.dal.query(query, [id]);
      if (result.rows.length === 0) {
        const error = new DocumentNotFound(`invite_links with id ${id} not found`);
        error.name = 'DocumentNotFoundError';
        throw error;
      }

      return normalizeInviteInstance(this.createFromRow(result.rows[0] as Record<string, unknown>));
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
