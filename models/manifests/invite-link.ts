import { randomUUID } from 'node:crypto';

import config from 'config';

import dal from '../../dal/index.ts';
import type { ManifestTypeExports } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';
import type { UserView } from './user.ts';

const { types } = dal;

const inviteLinkManifest = {
  tableName: 'invite_links',
  hasRevisions: false as const,
  schema: {
    id: types
      .string()
      .uuid(4)
      .default(() => randomUUID()),
    createdBy: types.string().uuid(4).required(true),
    createdOn: types.date().default(() => new Date()),
    usedBy: types.string().uuid(4),
    // Note: usedByUser relation is typed via intersection pattern on InviteLinkInstance
    url: types.virtual().default(function (this: InviteLinkTypes['BaseInstance']) {
      const identifier = typeof this.getValue === 'function' ? this.getValue('id') : this.id;
      return identifier ? `${config.qualifiedURL}register/${identifier}` : undefined;
    }),
  },
  camelToSnake: {
    createdBy: 'created_by',
    createdOn: 'created_on',
    usedBy: 'used_by',
  },
} as const satisfies ModelManifest;

type InviteLinkRelations = { usedByUser?: UserView };

type InviteLinkTypes = ManifestTypeExports<
  typeof inviteLinkManifest,
  InviteLinkRelations,
  {
    getAvailable(user: { id?: string }): Promise<InviteLinkTypes['Instance'][]>;
    getUsed(user: { id?: string }): Promise<InviteLinkTypes['Instance'][]>;
    get(id: string): Promise<InviteLinkTypes['Instance']>;
  }
>;

// Use intersection pattern for relation types
export type InviteLinkInstanceMethods = InviteLinkTypes['InstanceMethods'];
export type InviteLinkInstance = InviteLinkTypes['Instance'];
export type InviteLinkStaticMethods = InviteLinkTypes['StaticMethods'];
export type InviteLinkModel = InviteLinkTypes['Model'];

/**
 * Create a lazy reference to the InviteLink model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed InviteLink model constructor
 */
export function referenceInviteLink(): InviteLinkModel {
  return referenceModel(inviteLinkManifest) as InviteLinkModel;
}

export default inviteLinkManifest;
