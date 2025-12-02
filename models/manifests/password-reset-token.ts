import { randomUUID } from 'node:crypto';

import dal from '../../dal/index.ts';
import type { ManifestExports } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';
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

type PasswordResetTokenTypes = ManifestExports<
  typeof passwordResetTokenManifest,
  {
    relations: { user?: UserInstance };
    statics: {
      create(
        userID: string,
        email: string,
        ipAddress?: string
      ): Promise<PasswordResetTokenTypes['Instance']>;
      findByID(tokenID: string): Promise<PasswordResetTokenTypes['Instance'] | null>;
      invalidateAllForUser(userID: string): Promise<void>;
      hasRecentRequest(email: string, cooldownHours: number): Promise<boolean>;
    };
    instances: {
      isValid(): boolean;
      markAsUsed(): Promise<void>;
      getUser(): Promise<UserInstance | null>;
    };
  }
>;

export type PasswordResetTokenInstance = PasswordResetTokenTypes['Instance'];
export type PasswordResetTokenModel = PasswordResetTokenTypes['Model'];
export type PasswordResetTokenStaticMethods = PasswordResetTokenTypes['StaticMethods'];
export type PasswordResetTokenInstanceMethods = PasswordResetTokenTypes['InstanceMethods'];

/**
 * Lazy reference to the PasswordResetToken model for use in other manifests.
 */
export function referencePasswordResetToken(): PasswordResetTokenModel {
  return referenceModel(passwordResetTokenManifest) as PasswordResetTokenModel;
}

export default passwordResetTokenManifest;
