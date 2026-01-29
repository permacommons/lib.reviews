import { defineModel, defineStaticMethods } from 'rev-dal/lib/create-model';
import debug from '../util/debug.ts';
import accountRequestManifest, {
  type AccountRequestInstance,
  type AccountRequestModel,
  type AccountRequestStaticMethods,
} from './manifests/account-request.ts';

const accountRequestStaticMethods = defineStaticMethods(accountRequestManifest, {
  /**
   * Get all pending account requests ordered by creation date (oldest first).
   */
  async getPending() {
    try {
      return await this.filterWhere({ status: 'pending' })
        .includeSensitive(['email', 'ipAddress'])
        .orderBy('createdAt', 'ASC')
        .run();
    } catch (error) {
      debug.error('Failed to fetch pending account requests:', error);
      return [];
    }
  },

  /**
   * Fetch recently moderated requests for the moderator log tab.
   *
   * @param limit - Maximum number of records to return
   */
  async getModerated(limit = 100) {
    try {
      return await this.filterWhere({ status: this.ops.neq('pending') })
        .includeSensitive(['email', 'ipAddress'])
        .orderBy('moderatedAt', 'DESC')
        .limit(limit)
        .run();
    } catch (error) {
      debug.error('Failed to fetch moderated account requests:', error);
      return [];
    }
  },

  /**
   * Determine whether a given email already has a request (of any status)
   * within the cooldown window.
   *
   * @param email - Email address to check
   * @param cooldownHours - Cooldown duration in hours
   * @returns True when any request exists in the window
   */
  async hasRecentRequest(email: string, cooldownHours: number): Promise<boolean> {
    if (!email || cooldownHours <= 0) return false;

    const cutoff = new Date(Date.now() - cooldownHours * 60 * 60 * 1000);
    try {
      const recent = await this.filterWhere({
        email: email.toLowerCase(),
        createdAt: this.ops.gte(cutoff),
      }).first();
      return !!recent;
    } catch (error) {
      debug.error('Failed to check recent account requests by email:', error);
      return false;
    }
  },

  /**
   * Check whether an IP address exceeded the configured rate limit.
   *
   * @param ipAddress - Requester IP address
   * @param maxRequests - Maximum allowed requests
   * @param windowHours - Lookback window in hours
   * @returns True when the number of requests meets/exceeds the limit
   */
  async checkIPRateLimit(
    ipAddress: string | undefined,
    maxRequests: number,
    windowHours: number
  ): Promise<boolean> {
    if (!ipAddress || maxRequests <= 0 || windowHours <= 0) {
      return false;
    }

    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    try {
      const requests = await this.filterWhere({
        ipAddress,
        createdAt: this.ops.gte(cutoff),
      }).run();
      return (requests?.length ?? 0) >= maxRequests;
    } catch (error) {
      debug.error('Failed to check account request rate limits:', error);
      return false;
    }
  },

  /**
   * Create and persist a new account request.
   *
   * @param data - Request payload from the form
   * @returns The persisted request instance
   */
  async createRequest(data: {
    plannedReviews: string;
    languages: string;
    aboutLinks: string;
    email: string;
    language: string;
    termsAccepted: boolean;
    ipAddress?: string;
  }) {
    const request = new this({}) as AccountRequestInstance;
    request.plannedReviews = data.plannedReviews;
    request.languages = data.languages;
    request.aboutLinks = data.aboutLinks;
    request.email = data.email.toLowerCase();
    request.language = data.language;
    request.termsAccepted = data.termsAccepted;
    request.ipAddress = data.ipAddress;
    request.status = 'pending';
    request.createdAt = new Date();

    try {
      await request.save();
      return request;
    } catch (error) {
      debug.error('Failed to create account request:', error);
      throw error;
    }
  },
}) satisfies AccountRequestStaticMethods;

const AccountRequest = defineModel(accountRequestManifest, {
  staticMethods: accountRequestStaticMethods,
}) as AccountRequestModel;

export default AccountRequest;
export type {
  AccountRequestInstance,
  AccountRequestModel,
  AccountRequestStaticMethods,
} from './manifests/account-request.ts';
