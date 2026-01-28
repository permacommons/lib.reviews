import { randomUUID } from 'node:crypto';

import dal from 'rev-dal';
import type {
  InstanceMethodsFrom,
  ManifestInstance,
  ManifestModel,
  StaticMethodsFrom,
} from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { ModelManifest } from 'rev-dal/lib/model-manifest';
import type { UserInstance } from './user.ts';

const { types } = dal;

const passwordResetTokenManifest = {
  tableName: 'password_reset_tokens',
  hasRevisions: false as const,
  schema: {
    id: types
      .string()
      .uuid(4)
      .default(() => randomUUID()),
    userID: types.string().uuid(4).required(true),
    email: types.string().max(128).required(true).sensitive(),
    createdAt: types.date().default(() => new Date()),
    expiresAt: types.date().required(true),
    usedAt: types.date(),
    ipAddress: types.string().max(64).sensitive(),
  },
  camelToSnake: {
    userID: 'user_id',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    usedAt: 'used_at',
    ipAddress: 'ip_address',
  },
} as const satisfies ModelManifest;

export type PasswordResetTokenRelations = { user?: UserInstance };

export type PasswordResetTokenInstanceMethodsMap = {
  isValid(): boolean;
  markAsUsed(): Promise<void>;
  getUser(): Promise<UserInstance | null>;
};
export type PasswordResetTokenInstanceMethods = InstanceMethodsFrom<
  typeof passwordResetTokenManifest,
  PasswordResetTokenInstanceMethodsMap,
  PasswordResetTokenRelations
>;
export type PasswordResetTokenInstance =
  ManifestInstance<typeof passwordResetTokenManifest, PasswordResetTokenInstanceMethods> &
  PasswordResetTokenRelations;

export type PasswordResetTokenStaticMethodsMap = {
  create(userID: string, email: string, ipAddress?: string): Promise<PasswordResetTokenInstance>;
  findByID(tokenID: string): Promise<PasswordResetTokenInstance | null>;
  invalidateAllForUser(userID: string): Promise<void>;
  hasRecentRequest(email: string, cooldownHours: number): Promise<boolean>;
};
export type PasswordResetTokenStaticMethods = StaticMethodsFrom<
  typeof passwordResetTokenManifest,
  PasswordResetTokenStaticMethodsMap,
  PasswordResetTokenInstanceMethods,
  PasswordResetTokenRelations
>;
export type PasswordResetTokenModel = ManifestModel<
  typeof passwordResetTokenManifest,
  PasswordResetTokenStaticMethods,
  PasswordResetTokenInstanceMethods
>;

/**
 * Lazy reference to the PasswordResetToken model for use in other manifests.
 */
export function referencePasswordResetToken(): PasswordResetTokenModel {
  return referenceModel(passwordResetTokenManifest) as PasswordResetTokenModel;
}

export default passwordResetTokenManifest;
