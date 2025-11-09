import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';
import unescapeHTML from 'unescape-html';

import dal from '../dal/index.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import types from '../dal/lib/type.ts';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';
import TeamJoinRequest, { type TeamJoinRequestInstance } from './team-join-request.ts';
import TeamSlug from './team-slug.ts';
import User from './user.ts';

// TODO: Convert Team/Review to share manifest + type contracts to remove this lazy import.
async function getReviewModel() {
  const module = await import('./review.ts');
  return module.default;
}

const { mlString } = dal;
const { isValid: isValidLanguage } = languages;

/**
 * Validate the structure of multilingual text/HTML objects stored on the team.
 *
 * @param value - Value to validate
 * @returns True if the value matches the expected structure
 */
function validateTextHtmlObject(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Description/rules must be an object with text and html properties');

  const record = value as Record<string, unknown>;
  if (record.text !== undefined) mlString.validate(record.text);

  if (record.html !== undefined) mlString.validate(record.html);

  return true;
}

/**
 * Validate the permissions configuration stored on the team record.
 *
 * @param value - Value to validate
 * @returns True if the permissions object is valid
 */
function validateConfersPermissions(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Confers permissions must be an object');

  const validPermissions = ['show_error_details', 'translate'];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (validPermissions.includes(key) && typeof val !== 'boolean')
      throw new Error(`Permission ${key} must be a boolean`);
  }

  return true;
}

/**
 * Normalize a string into a slug-safe representation.
 *
 * @param str - Source string to convert
 * @returns Slugified name suitable for URLs
 */
function generateSlugName(str: string): string {
  if (typeof str !== 'string') throw new Error('Source string is undefined or not a string.');

  const trimmed = str.trim();
  if (trimmed === '') throw new Error('Source string cannot be empty.');

  const slugName = unescapeHTML(trimmed)
    .trim()
    .toLowerCase()
    .replace(/[?&"″'`'<>:]/g, '')
    .replace(/[ _/]/g, '-')
    .replace(/-{2,}/g, '-');

  if (!slugName) throw new Error('Source string cannot be converted to a valid slug.');

  if (isUUID.v4(slugName)) throw new Error('Source string cannot be a UUID.');

  return slugName;
}

interface GetWithDataOptions {
  withMembers?: boolean;
  withModerators?: boolean;
  withJoinRequests?: boolean;
  withJoinRequestDetails?: boolean;
  withReviews?: boolean;
  reviewLimit?: number;
  reviewOffsetDate?: Date | null;
}

// Manifest-based model definition
const teamManifest = defineModelManifest({
  tableName: 'teams',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),
    name: mlString.getSchema({ maxLength: 100 }),
    motto: mlString.getSchema({ maxLength: 200 }),
    description: types.object().validator(validateTextHtmlObject),
    rules: types.object().validator(validateTextHtmlObject),
    modApprovalToJoin: types.boolean().default(false),
    onlyModsCanBlog: types.boolean().default(false),
    createdBy: types.string().uuid(4).required(true),
    createdOn: types.date().required(true),
    canonicalSlugName: types.string(),
    originalLanguage: types.string().max(4).validator(isValidLanguage),
    confersPermissions: types.object().validator(validateConfersPermissions),
    reviewOffsetDate: types.virtual().default(null),
    userIsFounder: types.virtual().default(false),
    userIsMember: types.virtual().default(false),
    userIsModerator: types.virtual().default(false),
    userCanBlog: types.virtual().default(false),
    userCanJoin: types.virtual().default(false),
    userCanLeave: types.virtual().default(false),
    userCanEdit: types.virtual().default(false),
    userCanDelete: types.virtual().default(false),
    urlID: types.virtual().default(function (this: ModelInstance) {
      const slugName =
        typeof this.getValue === 'function'
          ? this.getValue('canonicalSlugName')
          : this.canonicalSlugName;
      return slugName ? encodeURIComponent(String(slugName)) : this.id;
    }),
  },
  camelToSnake: {
    modApprovalToJoin: 'mod_approval_to_join',
    onlyModsCanBlog: 'only_mods_can_blog',
    createdBy: 'created_by',
    createdOn: 'created_on',
    canonicalSlugName: 'canonical_slug_name',
    originalLanguage: 'original_language',
    confersPermissions: 'confers_permissions',
  },
  relations: [
    {
      name: 'members',
      targetTable: 'users',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: false,
      through: {
        table: 'team_members',
        sourceForeignKey: 'team_id',
        targetForeignKey: 'user_id',
      },
      cardinality: 'many',
    },
    {
      name: 'moderators',
      targetTable: 'users',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: false,
      through: {
        table: 'team_moderators',
        sourceForeignKey: 'team_id',
        targetForeignKey: 'user_id',
      },
      cardinality: 'many',
    },
  ],
  staticMethods: {
    /**
     * Retrieve a team and optionally include membership, moderation, join
     * request, and review data.
     *
     * @param id - Team identifier to look up
     * @param options - Controls which associations are hydrated
     * @returns The team instance enriched with the requested data
     */
    async getWithData(id: string, options: GetWithDataOptions = {}): Promise<TeamInstance> {
      const team = (await this.getNotStaleOrDeleted(id)) as TeamInstance | null;
      if (!team) throw new Error(`Team ${id} not found`);

      const {
        withMembers = true,
        withModerators = true,
        withJoinRequests = true,
        withJoinRequestDetails = false,
        withReviews = false,
        reviewLimit = 1,
        reviewOffsetDate = null,
      } = options;

      if (withMembers) {
        team.members = await getTeamMembers(this, id);
      }

      if (withModerators) {
        team.moderators = await getTeamModerators(this, id);
      }

      if (withJoinRequests) {
        team.joinRequests = await getTeamJoinRequests(this, id, withJoinRequestDetails);
      }

      if (withReviews) {
        const reviewData = await getTeamReviews(this, id, reviewLimit, reviewOffsetDate);
        const reviews = reviewData.reviews;
        team.reviews = reviews;
        team.reviewCount = reviewData.totalCount;

        if (reviewData.hasMore && reviews.length > 0) {
          const lastReview = reviews[reviews.length - 1];
          const offsetDate = (lastReview?.createdOn ?? lastReview?.created_on) as Date | undefined;
          if (offsetDate) {
            team.reviewOffsetDate = offsetDate;
            team.review_offset_date = offsetDate;
          }
        }
      }

      return team;
    },
  },
  instanceMethods: {
    /**
     * Populate permission flags on this team instance relative to the provided
     * viewer.
     *
     * @param user - Viewer whose relationship determines permissions
     */
    populateUserInfo(this: ModelInstance, user: ModelInstance | null | undefined): void {
      if (!user) return;

      if (
        this.members &&
        Array.isArray(this.members) &&
        this.members.some((member: ModelInstance) => member.id === user.id)
      )
        this.userIsMember = true;

      if (
        this.moderators &&
        Array.isArray(this.moderators) &&
        this.moderators.some((moderator: ModelInstance) => moderator.id === user.id)
      )
        this.userIsModerator = true;

      if (user.id === this.createdBy) this.userIsFounder = true;

      if (this.userIsMember && (!this.onlyModsCanBlog || this.userIsModerator))
        this.userCanBlog = true;

      if (
        !this.userIsMember &&
        (!this.joinRequests ||
          !(
            Array.isArray(this.joinRequests) &&
            this.joinRequests.some(
              (request: ModelInstance) => request.userID === user.id && request.status === 'pending'
            )
          ))
      )
        this.userCanJoin = true;

      if (this.userIsFounder || this.userIsModerator || user.isSuperUser) this.userCanEdit = true;

      if (user.isSuperUser || user.isSiteModerator) this.userCanDelete = true;

      if (!this.userIsFounder && this.userIsMember) this.userCanLeave = true;
    },

    /**
     * Create or update the canonical slug for the team when the label changes.
     *
     * @param userID - Identifier of the user responsible for the change
     * @param language - Preferred language for slug generation
     * @returns The updated team instance
     */
    async updateSlug(
      this: ModelInstance,
      userID: string,
      language?: string | null
    ): Promise<ModelInstance> {
      const originalLanguage = (this.originalLanguage as string | undefined) || 'en';
      const slugLanguage = language || originalLanguage;

      if (slugLanguage !== originalLanguage) return this;

      if (!this.name) return this;

      const resolved = mlString.resolve(slugLanguage, this.name as Record<string, string>);
      if (!resolved || typeof resolved.str !== 'string' || !resolved.str.trim()) return this;

      let baseSlug: string;
      try {
        baseSlug = generateSlugName(resolved.str);
      } catch (error) {
        debug.error('Error generating slug');
        debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
        return this;
      }

      if (!baseSlug || baseSlug === this.canonicalSlugName) return this;

      if (!this.id) this.id = randomUUID();

      const slug = new (TeamSlug as new (data: Record<string, unknown>) => ModelInstance)({});
      slug.slug = baseSlug;
      slug.name = baseSlug;
      slug.teamID = this.id;
      slug.createdOn = new Date();
      slug.createdBy = userID;

      const savedSlug = await (
        slug as ModelInstance & { qualifiedSave(): Promise<ModelInstance> }
      ).qualifiedSave();
      if (savedSlug && savedSlug.name) {
        this.canonicalSlugName = savedSlug.name;
        const changedSet = this._changed as Set<string> | undefined;
        if (typeof Team._getDbFieldName === 'function' && changedSet) {
          changedSet.add(Team._getDbFieldName('canonicalSlugName') as string);
        }
      }

      return this;
    },
  },
} as const);

const Team = defineModel(teamManifest);

export type TeamInstance = InferInstance<typeof teamManifest>;
export type TeamModel = InferConstructor<typeof teamManifest>;

/**
 * Look up the active members for a team, omitting sensitive fields.
 *
 * @param model - Team model constructor
 * @param teamId - Identifier of the team to query
 * @returns Array of member records
 */
async function getTeamMembers(model: TeamModel, teamId: string): Promise<ModelInstance[]> {
  try {
    const dal = model.dal;
    const memberTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}team_members`
      : 'team_members';
    const userTableName = dal.schemaNamespace ? `${dal.schemaNamespace}users` : 'users';

    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${memberTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;

    const result = await dal.query(query, [teamId]);
    return result.rows.map(row => {
      const record = row as Record<string, unknown>;
      delete record.password;
      delete record.email;
      return User.createFromRow(record);
    });
  } catch (error) {
    debug.error('Error getting team members');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return [];
  }
}

/**
 * Look up the moderators associated with a team, omitting sensitive fields.
 *
 * @param model - Team model constructor
 * @param teamId - Identifier of the team to query
 * @returns Array of moderator records
 */
async function getTeamModerators(model: TeamModel, teamId: string): Promise<ModelInstance[]> {
  try {
    const dal = model.dal;
    const moderatorTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}team_moderators`
      : 'team_moderators';
    const userTableName = dal.schemaNamespace ? `${dal.schemaNamespace}users` : 'users';

    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${moderatorTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;

    const result = await dal.query(query, [teamId]);
    return result.rows.map(row => {
      const record = row as Record<string, unknown>;
      delete record.password;
      delete record.email;
      return User.createFromRow(record);
    });
  } catch (error) {
    debug.error('Error getting team moderators');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return [];
  }
}

/**
 * Fetch pending join requests for a team, optionally including requester
 * details.
 *
 * @param model - Team model constructor
 * @param teamId - Identifier of the team to query
 * @param withDetails - Whether to load user objects for each request
 * @returns Array of join request records
 */
async function getTeamJoinRequests(
  model: TeamModel,
  teamId: string,
  withDetails = false
): Promise<ModelInstance[]> {
  let query = '';

  try {
    const dal = model.dal;
    const joinRequestTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}team_join_requests`
      : 'team_join_requests';

    query = `SELECT * FROM ${joinRequestTableName} WHERE team_id = $1`;
    const result = await dal.query(query, [teamId]);

    const requests: (TeamJoinRequestInstance & { user?: ModelInstance })[] = result.rows.map(row =>
      TeamJoinRequest.createFromRow(row as Record<string, unknown>)
    );

    if (withDetails) {
      for (const request of requests) {
        const userID = request.userID as string | undefined;
        if (userID) {
          try {
            const user = await (User as unknown as { get(id: string): Promise<ModelInstance> }).get(
              userID
            );
            if (user) {
              delete (user as Record<string, unknown>).password;
              request.user = user;
            }
          } catch (error) {
            debug.error(`Error loading user ${request.userID} for join request`);
            debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
          }
        }
      }
    }

    return requests;
  } catch (error) {
    debug.error('Error getting team join requests');
    debug.error(`Query: ${query}`);
    debug.error(`Params: ${JSON.stringify([teamId])}`);
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return [];
  }
}

/**
 * Fetch reviews associated with a team using the review feed join table.
 *
 * @param model - Team model constructor
 * @param teamId - Identifier of the team to query
 * @param limit - Maximum number of reviews to return
 * @param offsetDate - Optional timestamp used for pagination
 * @returns Reviews, total count, and pagination metadata
 */
async function getTeamReviews(
  model: typeof Team,
  teamId: string,
  limit: number,
  offsetDate?: Date | null
): Promise<{ reviews: ModelInstance[]; totalCount: number; hasMore: boolean }> {
  try {
    const dal = (
      model as unknown as {
        dal: {
          query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
          schemaNamespace?: string;
        };
      }
    ).dal;
    const reviewTeamTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}review_teams`
      : 'review_teams';
    const reviewTableName = dal.schemaNamespace ? `${dal.schemaNamespace}reviews` : 'reviews';
    let query = `
      SELECT r.id, r.created_on FROM ${reviewTableName} r
      JOIN ${reviewTeamTableName} rt ON r.id = rt.review_id
      WHERE rt.team_id = $1
        AND (r._old_rev_of IS NULL)
        AND (r._rev_deleted IS NULL OR r._rev_deleted = false)
    `;

    const params: (string | Date | number)[] = [teamId];
    let paramIndex = 2;

    if (offsetDate) {
      query += ` AND r.created_on < $${paramIndex}`;
      params.push(offsetDate);
      paramIndex++;
    }

    query += ` ORDER BY r.created_on DESC LIMIT $${paramIndex}`;
    params.push(limit + 1);

    const reviewResult = await dal.query(query, params);
    const reviewIDs = reviewResult.rows.map((row: Record<string, unknown>) => row.id as string);
    const reviews: ModelInstance[] = [];
    const hasMoreRows = reviewResult.rows.length > limit;

    if (reviewIDs.length) {
      const Review = await getReviewModel();
      for (const reviewId of reviewIDs) {
        try {
          const review = await (
            Review as unknown as { getWithData(id: string): Promise<ModelInstance> }
          ).getWithData(reviewId);
          if (review) reviews.push(review);
        } catch (error) {
          debug.error('Error loading review for team');
          debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
        }
      }
    }

    if (hasMoreRows && reviews.length > limit) reviews.length = limit;

    const countQuery = `
      SELECT COUNT(*) as total FROM ${reviewTableName} r
      JOIN ${reviewTeamTableName} rt ON r.id = rt.review_id
      WHERE rt.team_id = $1
        AND (r._old_rev_of IS NULL)
        AND (r._rev_deleted IS NULL OR r._rev_deleted = false)
    `;

    const countResult = await dal.query(countQuery, [teamId]);

    return {
      reviews,
      totalCount: parseInt((countResult.rows[0] as { total?: string })?.total ?? '0', 10),
      hasMore: hasMoreRows && reviews.length === limit,
    };
  } catch (error) {
    debug.error('Error getting team reviews');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return { reviews: [], totalCount: 0, hasMore: false };
  }
}

export default Team;
