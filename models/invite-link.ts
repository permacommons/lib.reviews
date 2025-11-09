import { randomUUID } from 'node:crypto';
import config from 'config';
import isUUID from 'is-uuid';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import types from '../dal/lib/type.ts';
import debug from '../util/debug.ts';

// Manifest-based model definition
const inviteLinkManifest = defineModelManifest({
  tableName: 'invite_links',
  hasRevisions: false,
  schema: {
    id: types
      .string()
      .uuid(4)
      .default(() => randomUUID()),
    createdBy: types.string().uuid(4).required(true),
    createdOn: types.date().default(() => new Date()),
    usedBy: types.string().uuid(4),
    url: types.virtual().default(function () {
      const identifier = this.getValue ? this.getValue('id') : this.id;
      return identifier ? `${config.qualifiedURL}register/${identifier}` : undefined;
    }),
  },
  camelToSnake: {
    createdBy: 'created_by',
    createdOn: 'created_on',
    usedBy: 'used_by',
  },
  staticMethods: {
    /**
     * Get pending invite links created by the given user.
     *
     * @param user - User whose pending invites to load
     * @returns Pending invite links, newest first
     */
    async getAvailable(user: { id?: string }) {
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
    async getUsed(user: { id?: string }) {
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

        const usedByIds = [...new Set(invites.map(invite => invite.usedBy).filter(Boolean))];
        if (usedByIds.length === 0) {
          return invites;
        }

        const userQuery = `
          SELECT id, display_name, canonical_name, registration_date, is_trusted, is_site_moderator, is_super_user
          FROM users
          WHERE id = ANY($1)
        `;
        const userResult = await this.dal.query(userQuery, [usedByIds]);
        const userMap = new Map();

        userResult.rows.forEach((row: Record<string, unknown>) => {
          userMap.set(row.id, {
            ...row,
            displayName: row.display_name,
            urlName:
              row.canonical_name ||
              (row.display_name
                ? encodeURIComponent(String(row.display_name).replace(/ /g, '_'))
                : undefined),
            registrationDate: row.registration_date,
          });
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

        return normalizeInviteInstance(
          this.createFromRow(result.rows[0] as Record<string, unknown>)
        );
      } catch (error) {
        if (
          error instanceof DocumentNotFound ||
          (error as Error).name === 'DocumentNotFoundError'
        ) {
          throw error;
        }
        debug.error('Failed to fetch invite link by id:', error);
        throw error;
      }
    },
  },
} as const);

export type InviteLinkInstance = InferInstance<typeof inviteLinkManifest>;
export type InviteLinkModel = InferConstructor<typeof inviteLinkManifest>;

const InviteLink = defineModel(inviteLinkManifest);

export default InviteLink;

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
