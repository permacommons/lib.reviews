import config from 'config';
import isUUID from 'is-uuid';

import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import debug from '../util/debug.ts';
import passwordResetTokenManifest, {
  type PasswordResetTokenInstance,
  type PasswordResetTokenInstanceMethods,
  type PasswordResetTokenModel,
  type PasswordResetTokenStaticMethods,
} from './manifests/password-reset-token.ts';
import { referenceUser, type UserInstance } from './manifests/user.ts';

const User = referenceUser();

const passwordResetTokenStaticMethods = defineStaticMethods(passwordResetTokenManifest, {
  /**
   * Create a new token for the provided user and email.
   *
   * @param userID - User identifier the token belongs to
   * @param email - Email address used for the request (stored for auditing)
   * @param ipAddress - Optional IP address recorded for the request
   * @returns The persisted token instance
   */
  async create(userID: string, email: string, ipAddress?: string) {
    const expirationHours = config.get<number>('passwordReset.tokenExpirationHours') ?? 3;
    const expiresAt = new Date(Date.now() + expirationHours * 60 * 60 * 1000);

    const token = new this({}) as PasswordResetTokenInstance;
    token.userID = userID;
    token.email = email;
    token.ipAddress = ipAddress;
    token.expiresAt = expiresAt;
    token.createdAt = new Date();

    await token.save();
    return token;
  },

  /**
   * Fetch a token by id, returning null when not found or invalid.
   *
   * @param tokenID - Token identifier (UUID v4)
   * @returns Token instance or null
   */
  async findByID(tokenID: string) {
    if (!tokenID || !isUUID.v4(tokenID)) {
      return null;
    }

    try {
      const token = (await this.filterWhere({
        id: tokenID,
      })
        .includeSensitive(['email', 'ipAddress'])
        .first()) as PasswordResetTokenInstance | null;
      return token ?? null;
    } catch (error) {
      debug.error('Failed to fetch password reset token by id:', error);
      return null;
    }
  },

  /**
   * Mark all unused tokens for a user as used.
   *
   * @param userID - User whose existing tokens should be invalidated
   */
  async invalidateAllForUser(userID: string) {
    if (!userID) return;

    try {
      const tokens = (await this.filterWhere({ userID, usedAt: null })
        .includeSensitive(['email', 'ipAddress'])
        .run()) as PasswordResetTokenInstance[] | null;
      if (!tokens) return;

      for (const token of tokens) {
        token.usedAt = new Date();
        await token.save();
      }
    } catch (error) {
      debug.error('Failed to invalidate password reset tokens for user:', error);
    }
  },

  /**
   * Determine whether the email has an active cooldown.
   *
   * @param email - Email to check for recent activity
   * @param cooldownHours - Cooldown duration in hours
   * @returns True when a request exists within the cooldown window
   */
  async hasRecentRequest(email: string, cooldownHours: number): Promise<boolean> {
    if (!email || cooldownHours <= 0) return false;

    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    try {
      const recent = await this.filterWhere({
        email,
        usedAt: null,
        createdAt: this.ops.gt(cutoff),
      }).first();
      return !!recent;
    } catch (error) {
      debug.error('Failed to check recent password reset requests:', error);
      return false;
    }
  },
}) satisfies PasswordResetTokenStaticMethods;

const passwordResetTokenInstanceMethods = defineInstanceMethods(passwordResetTokenManifest, {
  /**
   * Check whether the token is unused and unexpired.
   *
   * @returns True when token is eligible for use
   */
  isValid() {
    if (this.usedAt) return false;
    if (!this.expiresAt) return false;
    return this.expiresAt.getTime() > Date.now();
  },

  /**
   * Persist the token as used.
   */
  async markAsUsed() {
    this.usedAt = new Date();
    await this.save();
  },

  /**
   * Fetch the associated user for this token.
   *
   * @returns User instance or null when missing
   */
  async getUser() {
    if (!this.userID) return null;

    try {
      const user = (await User.get(this.userID)) as UserInstance | null;
      return user;
    } catch (error) {
      debug.error('Failed to fetch user for password reset token:', error);
      return null;
    }
  },
}) satisfies PasswordResetTokenInstanceMethods;

const PasswordResetToken = defineModel(passwordResetTokenManifest, {
  staticMethods: passwordResetTokenStaticMethods,
  instanceMethods: passwordResetTokenInstanceMethods,
}) as PasswordResetTokenModel;

export default PasswordResetToken;
export type {
  PasswordResetTokenInstance,
  PasswordResetTokenInstanceMethods,
  PasswordResetTokenModel,
  PasswordResetTokenStaticMethods,
} from './manifests/password-reset-token.ts';
