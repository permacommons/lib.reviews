import { randomUUID } from 'node:crypto';

import config from 'config';

import dal from '../../dal/index.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferConstructor,
  InferInstance,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
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
    usedByUser: types.virtual().returns<UserView | undefined>().default(undefined),
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

type InviteLinkInstanceBase = InferInstance<typeof inviteLinkManifest>;
type InviteLinkModelBase = InferConstructor<typeof inviteLinkManifest>;

export type InviteLinkInstanceMethods = Record<never, never>;

export interface InviteLinkStaticMethods {
  getAvailable(
    this: InviteLinkModelBase & InviteLinkStaticMethods,
    user: { id?: string }
  ): Promise<InviteLinkInstance[]>;
  getUsed(
    this: InviteLinkModelBase & InviteLinkStaticMethods,
    user: { id?: string }
  ): Promise<InviteLinkInstance[]>;
  get(this: InviteLinkModelBase & InviteLinkStaticMethods, id: string): Promise<InviteLinkInstance>;
}

export type InviteLinkInstance = InviteLinkInstanceBase & InviteLinkInstanceMethods;
export type InviteLinkModel = InviteLinkModelBase & InviteLinkStaticMethods;

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
