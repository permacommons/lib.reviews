import { randomUUID } from 'node:crypto';

import config from 'config';

import dal from '../../dal/index.ts';
import type {
  InstanceMethodsFrom,
  ManifestInstance,
  ManifestTypes,
  StaticMethodsFrom,
} from '../../dal/lib/create-model.ts';
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

export type InviteLinkInstanceMethods = InstanceMethodsFrom<
  typeof inviteLinkManifest,
  InviteLinkRelations,
  Record<never, never>
>;

export type InviteLinkStaticMethods = StaticMethodsFrom<
  typeof inviteLinkManifest,
  InviteLinkRelations,
  {
    getAvailable(user: { id?: string }): Promise<InviteLinkInstance[]>;
    getUsed(user: { id?: string }): Promise<InviteLinkInstance[]>;
    get(id: string): Promise<InviteLinkInstance>;
  },
  InviteLinkInstanceMethods
>;

type InviteLinkTypes = ManifestTypes<
  typeof inviteLinkManifest,
  InviteLinkStaticMethods,
  InviteLinkInstanceMethods,
  InviteLinkRelations
>;

// Use intersection pattern for relation types
export type InviteLinkInstance = ManifestInstance<
  typeof inviteLinkManifest,
  InviteLinkInstanceMethods
> &
  InviteLinkRelations;
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
