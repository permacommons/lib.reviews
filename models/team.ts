import { randomUUID } from 'crypto';
import isUUID from 'is-uuid';

import dal from '../dal/index.ts';
import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import debug from '../util/debug.ts';
import { generateSlugName } from '../util/slug.ts';
import { referenceReview } from './manifests/review.ts';
import teamManifest, {
  type TeamGetWithDataOptions,
  type TeamInstance,
  type TeamInstanceMethods,
  type TeamModel,
  type TeamStaticMethods,
} from './manifests/team.ts';
import { type TeamJoinRequestInstance } from './manifests/team-join-request.ts';
import TeamJoinRequest from './team-join-request.ts';
import TeamSlug from './team-slug.ts';
import User, { fetchUserPublicProfiles, type UserAccessContext, type UserView } from './user.ts';

const Review = referenceReview();

const { mlString } = dal;

type GetWithDataOptions = TeamGetWithDataOptions;

const teamStatics = {} as const;

const teamStaticMethods = defineStaticMethods(teamManifest, {
  /**
   * Retrieve a team and optionally include membership, moderation, join
   * request, and review data.
   *
   * @param id - Team identifier to look up
   * @param options - Controls which associations are hydrated
   * @returns The team instance enriched with the requested data
   */
  async getWithData(this: TeamModel, id: string, options: GetWithDataOptions = {}) {
    const team = (await this.getNotStaleOrDeleted(id)) as
      | (TeamInstance & Record<string, any>)
      | null;
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
}) satisfies TeamStaticMethods;

const teamInstanceMethods = defineInstanceMethods(teamManifest, {
  /**
   * Populate permission flags on this team instance relative to the provided
   * viewer.
   *
   * @param user - Viewer whose relationship determines permissions
   */
  populateUserInfo(this: TeamInstance, user: ModelInstance | UserAccessContext | null | undefined) {
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
  async updateSlug(this: TeamInstance, userID: string, language?: string | null) {
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
      this.canonicalSlugName = savedSlug.name as string;
      const changedSet = this._changed as Set<string> | undefined;
      if (typeof Team._getDbFieldName === 'function' && changedSet) {
        changedSet.add(Team._getDbFieldName('canonicalSlugName') as string);
      }
    }

    return this;
  },
}) satisfies TeamInstanceMethods;

const Team = defineModel(teamManifest, {
  statics: teamStatics,
  staticMethods: teamStaticMethods,
  instanceMethods: teamInstanceMethods,
}) as TeamModel;

/**
 * Look up the active members for a team, omitting sensitive fields.
 *
 * @param model - Team model constructor
 * @param teamId - Identifier of the team to query
 * @returns Array of member records
 */
async function getTeamMembers(model: TeamModel, teamId: string): Promise<UserView[]> {
  try {
    const dal = model.dal;
    const memberTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}team_members`
      : 'team_members';

    const query = `
      SELECT tm.user_id, tm.joined_on
      FROM ${memberTableName} tm
      WHERE tm.team_id = $1
      ORDER BY tm.joined_on ASC
    `;

    const result = await dal.query<{ user_id?: string }>(query, [teamId]);
    const memberRows = result.rows.filter(
      row => typeof row.user_id === 'string' && (row.user_id as string).length > 0
    );
    if (!memberRows.length) {
      return [];
    }

    const memberIDs = memberRows.map(row => row.user_id as string);
    const userMap = await fetchUserPublicProfiles(memberIDs);
    return memberRows
      .map(row => userMap.get(row.user_id as string))
      .filter((user): user is UserView => Boolean(user));
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
async function getTeamModerators(model: TeamModel, teamId: string): Promise<UserView[]> {
  try {
    const dal = model.dal;
    const moderatorTableName = dal.schemaNamespace
      ? `${dal.schemaNamespace}team_moderators`
      : 'team_moderators';

    const query = `
      SELECT tm.user_id, tm.appointed_on
      FROM ${moderatorTableName} tm
      WHERE tm.team_id = $1
      ORDER BY tm.appointed_on ASC
    `;

    const result = await dal.query<{ user_id?: string }>(query, [teamId]);
    const moderatorRows = result.rows.filter(
      row => typeof row.user_id === 'string' && (row.user_id as string).length > 0
    );

    if (!moderatorRows.length) {
      return [];
    }

    const moderatorIDs = moderatorRows.map(row => row.user_id as string);
    const userMap = await fetchUserPublicProfiles(moderatorIDs);
    return moderatorRows
      .map(row => userMap.get(row.user_id as string))
      .filter((user): user is UserView => Boolean(user));
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

    const requests: (TeamJoinRequestInstance & { user?: UserView })[] = result.rows.map(row =>
      TeamJoinRequest.createFromRow(row as Record<string, unknown>)
    );

    if (withDetails) {
      const requesterIDs = [
        ...new Set(
          requests
            .map(request => request.userID as string | undefined)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        ),
      ];

      if (requesterIDs.length > 0) {
        try {
          const userMap = await fetchUserPublicProfiles(requesterIDs);
          requests.forEach(request => {
            const requesterID = request.userID as string | undefined;
            if (requesterID && userMap.has(requesterID)) {
              request.user = userMap.get(requesterID);
            }
          });
        } catch (error) {
          debug.error('Error loading users for join requests');
          debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
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
  model: TeamModel,
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

/**
 * Batch-load a set of user IDs via the `UserView` projection.
 *
 * @param userIds - Raw user identifiers pulled from join tables
 * @returns Map keyed by user ID with the corresponding `UserView`
 */
export type {
  TeamGetWithDataOptions,
  TeamInstance,
  TeamInstanceMethods,
  TeamModel,
  TeamStaticMethods,
} from './manifests/team.ts';

export default Team;
