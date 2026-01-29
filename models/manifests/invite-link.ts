import { randomUUID } from 'node:crypto';

import config from 'config';

import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { InferInstance, ModelManifest } from 'rev-dal/lib/model-manifest';
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
    url: types.virtual().default(function (this: InferInstance<typeof inviteLinkManifest>) {
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

export type InviteLinkRelations = { usedByUser?: UserView };

export type InviteLinkInstanceMethodsMap = Record<never, never>;
export type InviteLinkInstance = ManifestInstance<
  typeof inviteLinkManifest,
  InviteLinkInstanceMethodsMap
> &
  InviteLinkRelations;

export type InviteLinkStaticMethodsMap = {
  getAvailable(user: { id?: string }): Promise<InviteLinkInstance[]>;
  getUsed(user: { id?: string }): Promise<InviteLinkInstance[]>;
  getAccountRequestLinks(user: { id?: string }): Promise<InviteLinkInstance[]>;
  get(id: string): Promise<InviteLinkInstance>;
};
type InviteLinkTypes = ManifestBundle<
  typeof inviteLinkManifest,
  InviteLinkRelations,
  InviteLinkStaticMethodsMap,
  InviteLinkInstanceMethodsMap
>;
export type InviteLinkInstanceMethods = InviteLinkTypes['InstanceMethods'];
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
