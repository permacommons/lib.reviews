import unescapeHTML from 'unescape-html';
import isUUID from 'is-uuid';
import { randomUUID } from 'crypto';

import dal from '../dal/index.ts';
import { createModelModule } from '../dal/lib/model-handle.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.ts';
import debug from '../util/debug.ts';
import languages from '../locales/languages.ts';
import User from './user.ts';
import Review from './review.ts';

type PostgresModule = typeof import('../db-postgres.ts');

type TeamRecord = JsonObject;
type TeamVirtual = JsonObject;
type TeamInstance = ModelInstance<TeamRecord, TeamVirtual> & Record<string, any>;
type TeamModel = ModelConstructor<TeamRecord, TeamVirtual, TeamInstance> & Record<string, any>;

const { proxy: teamHandleProxy, register: registerTeamHandle } = createModelModule<TeamRecord, TeamVirtual, TeamInstance>({
  tableName: 'teams'
});

const TeamHandle = teamHandleProxy as TeamModel;
const { types, mlString } = dal as unknown as { types: Record<string, any>; mlString: Record<string, any> };
const { isValid: isValidLanguage } = languages as unknown as { isValid: (code: string) => boolean };

let postgresModulePromise: Promise<PostgresModule> | null = null;
let teamJoinRequestHandlePromise: Promise<any> | null = null;
let teamSlugHandlePromise: Promise<any> | null = null;
let Team: TeamModel | null = null;

async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise)
    postgresModulePromise = import('../db-postgres.ts');

  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

async function loadTeamJoinRequestHandle(): Promise<any> {
  if (!teamJoinRequestHandlePromise)
    teamJoinRequestHandlePromise = import('./team-join-request.ts');

  const module = await teamJoinRequestHandlePromise;
  return module.default;
}

async function loadTeamSlugHandle(): Promise<any> {
  if (!teamSlugHandlePromise)
    teamSlugHandlePromise = import('./team-slug.ts');

  const module = await teamSlugHandlePromise;
  return module.default;
}

/**
 * Initialize the PostgreSQL Team model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if the DAL is unavailable
 */
export async function initializeTeamModel(dalInstance: Record<string, any> | null = null): Promise<TeamModel | null> {
  const activeDAL = dalInstance ?? await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping Team model initialization');
    return null;
  }

  try {
    const teamSchema = {
      id: types.string().uuid(4),
      name: mlString.getSchema({ maxLength: 100 }),
      motto: mlString.getSchema({ maxLength: 200 }),
      description: types.object().validator(_validateTextHtmlObject),
      rules: types.object().validator(_validateTextHtmlObject),
      modApprovalToJoin: types.boolean().default(false),
      onlyModsCanBlog: types.boolean().default(false),
      createdBy: types.string().uuid(4).required(true),
      createdOn: types.date().required(true),
      canonicalSlugName: types.string(),
      originalLanguage: types.string().max(4).validator(isValidLanguage),
      confersPermissions: types.object().validator(_validateConfersPermissions),
      reviewOffsetDate: types.virtual().default(null),
      userIsFounder: types.virtual().default(false),
      userIsMember: types.virtual().default(false),
      userIsModerator: types.virtual().default(false),
      userCanBlog: types.virtual().default(false),
      userCanJoin: types.virtual().default(false),
      userCanLeave: types.virtual().default(false),
      userCanEdit: types.virtual().default(false),
      userCanDelete: types.virtual().default(false),
      urlID: types.virtual().default(function (this: TeamInstance) {
        const slugName = typeof this.getValue === 'function' ? this.getValue('canonicalSlugName') : this.canonicalSlugName;
        return slugName ? encodeURIComponent(String(slugName)) : this.id;
      })
    } as JsonObject;

    const { model, isNew } = initializeModel<TeamRecord, TeamVirtual, TeamInstance>({
      dal: activeDAL as any,
      baseTable: 'teams',
      schema: teamSchema,
      camelToSnake: {
        modApprovalToJoin: 'mod_approval_to_join',
        onlyModsCanBlog: 'only_mods_can_blog',
        createdBy: 'created_by',
        createdOn: 'created_on',
        canonicalSlugName: 'canonical_slug_name',
        originalLanguage: 'original_language',
        confersPermissions: 'confers_permissions'
      },
      withRevision: {
        static: [
          'createFirstRevision',
          'getNotStaleOrDeleted',
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted'
        ],
        instance: ['newRevision', 'deleteAllRevisions']
      },
      staticMethods: {
        getWithData
      },
      instanceMethods: {
        populateUserInfo,
        updateSlug
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
            targetForeignKey: 'user_id'
          },
          cardinality: 'many'
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
            targetForeignKey: 'user_id'
          },
          cardinality: 'many'
        }
      ] as any
    });

    Team = model as TeamModel;

    if (!isNew)
      return Team;

    debug.db('PostgreSQL Team model initialized with all methods');
    return Team;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL Team model');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

/**
 * Retrieve a team and optionally include membership, moderation, join
 * request, and review data.
 *
 * @param id - Team identifier to look up
 * @param options - Controls which associations are hydrated
 * @returns The team instance enriched with the requested data
 */
async function getWithData(id: string, options: Record<string, any> = {}): Promise<TeamInstance> {
  const model = (Team ?? TeamHandle) as TeamModel;
  const team = await (model.getNotStaleOrDeleted ? model.getNotStaleOrDeleted(id) : model.get(id));
  if (!team)
    throw new Error(`Team ${id} not found`);

  const {
    withMembers = true,
    withModerators = true,
    withJoinRequests = true,
    withJoinRequestDetails = false,
    withReviews = false,
    reviewLimit = 1,
    reviewOffsetDate = null
  } = options;

  if (withMembers)
    team.members = await _getTeamMembers(id);

  if (withModerators)
    team.moderators = await _getTeamModerators(id);

  if (withJoinRequests)
    team.joinRequests = await _getTeamJoinRequests(id, withJoinRequestDetails);

  if (withReviews) {
    const reviewData = await _getTeamReviews(id, reviewLimit, reviewOffsetDate);
    team.reviews = reviewData.reviews;
    team.reviewCount = reviewData.totalCount;

    if (reviewData.hasMore && team.reviews.length > 0) {
      const lastReview = team.reviews[team.reviews.length - 1];
      const offsetDate = (lastReview?.createdOn ?? lastReview?.created_on) as Date | undefined;
      if (offsetDate) {
        team.reviewOffsetDate = offsetDate;
        team.review_offset_date = offsetDate;
      }
    }
  }

  return team as TeamInstance;
}

/**
 * Populate permission flags on this team instance relative to the provided
 * viewer.
 *
 * @param user - Viewer whose relationship determines permissions
 */
function populateUserInfo(this: TeamInstance, user: TeamInstance | null | undefined): void {
  if (!user)
    return;

  if (this.members && this.members.some(member => member.id === user.id))
    this.userIsMember = true;

  if (this.moderators && this.moderators.some(moderator => moderator.id === user.id))
    this.userIsModerator = true;

  if (user.id === this.createdBy)
    this.userIsFounder = true;

  if (this.userIsMember && (!this.onlyModsCanBlog || this.userIsModerator))
    this.userCanBlog = true;

  if (!this.userIsMember && (!this.joinRequests || !this.joinRequests.some(request =>
    request.userID === user.id && request.status === 'pending')))
    this.userCanJoin = true;

  if (this.userIsFounder || this.userIsModerator || user.isSuperUser)
    this.userCanEdit = true;

  if (user.isSuperUser || user.isSiteModerator)
    this.userCanDelete = true;

  if (!this.userIsFounder && this.userIsMember)
    this.userCanLeave = true;
}

/**
 * Look up the active members for a team, omitting sensitive fields.
 *
 * @param teamId - Identifier of the team to query
 * @returns Array of member records
 */
async function _getTeamMembers(teamId: string): Promise<Record<string, any>[]> {
  const model = (Team ?? TeamHandle) as TeamModel;

  try {
    const memberTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}team_members` : 'team_members';
    const userTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}users` : 'users';

    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${memberTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;

    const result = await model.dal.query(query, [teamId]);
    return result.rows.map((row: Record<string, any>) => {
      delete row.password;
      delete row.email;
      return (User as any)._createInstance(row);
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
 * @param teamId - Identifier of the team to query
 * @returns Array of moderator records
 */
async function _getTeamModerators(teamId: string): Promise<Record<string, any>[]> {
  const model = (Team ?? TeamHandle) as TeamModel;

  try {
    const moderatorTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}team_moderators` : 'team_moderators';
    const userTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}users` : 'users';

    const query = `
      SELECT u.* FROM ${userTableName} u
      JOIN ${moderatorTableName} tm ON u.id = tm.user_id
      WHERE tm.team_id = $1
    `;

    const result = await model.dal.query(query, [teamId]);
    return result.rows.map((row: Record<string, any>) => {
      delete row.password;
      delete row.email;
      return (User as any)._createInstance(row);
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
 * @param teamId - Identifier of the team to query
 * @param withDetails - Whether to load user objects for each request
 * @returns Array of join request records
 */
async function _getTeamJoinRequests(teamId: string, withDetails = false): Promise<Record<string, any>[]> {
  const model = (Team ?? TeamHandle) as TeamModel;
  const TeamJoinRequest = await loadTeamJoinRequestHandle();
  let query = '';

  try {
    const joinRequestTableName = model.dal.schemaNamespace ?
      `${model.dal.schemaNamespace}team_join_requests` : 'team_join_requests';

    query = `SELECT * FROM ${joinRequestTableName} WHERE team_id = $1`;
    const result = await model.dal.query(query, [teamId]);

    const requests = result.rows.map((row: Record<string, any>) =>
      TeamJoinRequest._createInstance ? TeamJoinRequest._createInstance(row) : new TeamJoinRequest(row)
    );

    if (withDetails) {
      for (const request of requests) {
        if (request.userID) {
          try {
            const user = await User.get(request.userID);
            if (user) {
              delete (user as Record<string, any>).password;
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
 * @param teamId - Identifier of the team to query
 * @param limit - Maximum number of reviews to return
 * @param offsetDate - Optional timestamp used for pagination
 * @returns Reviews, total count, and pagination metadata
 */
async function _getTeamReviews(teamId: string, limit: number, offsetDate?: Date | null): Promise<{ reviews: any[]; totalCount: number; hasMore: boolean }>
{
  const model = (Team ?? TeamHandle) as TeamModel;

  try {
    const reviewTeamTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}review_teams` : 'review_teams';
    const reviewTableName = model.dal.schemaNamespace ? `${model.dal.schemaNamespace}reviews` : 'reviews';
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

    const reviewResult = await model.dal.query(query, params);
    const reviewIDs = reviewResult.rows.map((row: Record<string, any>) => row.id);
    const reviews: any[] = [];
    const hasMoreRows = reviewResult.rows.length > limit;

    for (const reviewId of reviewIDs) {
      try {
        const review = await (Review as any).getWithData(reviewId);
        if (review)
          reviews.push(review);
      } catch (error) {
        debug.error('Error loading review for team');
        debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
      }
    }

    if (hasMoreRows && reviews.length > limit)
      reviews.length = limit;

    const countQuery = `
      SELECT COUNT(*) as total FROM ${reviewTableName} r
      JOIN ${reviewTeamTableName} rt ON r.id = rt.review_id
      WHERE rt.team_id = $1
        AND (r._old_rev_of IS NULL)
        AND (r._rev_deleted IS NULL OR r._rev_deleted = false)
    `;

    const countResult = await model.dal.query(countQuery, [teamId]);

    return {
      reviews,
      totalCount: parseInt(countResult.rows[0]?.total ?? '0', 10),
      hasMore: hasMoreRows && reviews.length === limit
    };
  } catch (error) {
    debug.error('Error getting team reviews');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return { reviews: [], totalCount: 0, hasMore: false };
  }
}

/**
 * Validate the structure of multilingual text/HTML objects stored on the team.
 *
 * @param value - Value to validate
 * @returns True if the value matches the expected structure
 */
function _validateTextHtmlObject(value: unknown): boolean {
  if (value === null || value === undefined)
    return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Description/rules must be an object with text and html properties');

  const record = value as Record<string, any>;
  if (record.text !== undefined)
    mlString.validate(record.text);

  if (record.html !== undefined)
    mlString.validate(record.html);

  return true;
}

/**
 * Validate the permissions configuration stored on the team record.
 *
 * @param value - Value to validate
 * @returns True if the permissions object is valid
 */
function _validateConfersPermissions(value: unknown): boolean {
  if (value === null || value === undefined)
    return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Confers permissions must be an object');

  const validPermissions = ['show_error_details', 'translate'];
  for (const [key, val] of Object.entries(value as Record<string, any>)) {
    if (validPermissions.includes(key) && typeof val !== 'boolean')
      throw new Error(`Permission ${key} must be a boolean`);
  }

  return true;
}

/**
 * Create or update the canonical slug for the team when the label changes.
 *
 * @param userID - Identifier of the user responsible for the change
 * @param language - Preferred language for slug generation
 * @returns The updated team instance
 */
async function updateSlug(this: TeamInstance, userID: string, language?: string | null): Promise<TeamInstance> {
  const TeamSlug = await loadTeamSlugHandle();
  const originalLanguage = this.originalLanguage || 'en';
  const slugLanguage = language || originalLanguage;

  if (slugLanguage !== originalLanguage)
    return this;

  if (!this.name)
    return this;

  const resolved = mlString.resolve(slugLanguage, this.name);
  if (!resolved || typeof resolved.str !== 'string' || !resolved.str.trim())
    return this;

  let baseSlug: string;
  try {
    baseSlug = _generateSlugName(resolved.str);
  } catch (error) {
    debug.error('Error generating slug');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return this;
  }

  if (!baseSlug || baseSlug === this.canonicalSlugName)
    return this;

  if (!this.id)
    this.id = randomUUID();

  const slug = new TeamSlug({});
  slug.slug = baseSlug;
  slug.name = baseSlug;
  slug.teamID = this.id;
  slug.createdOn = new Date();
  slug.createdBy = userID;

  const savedSlug = await slug.qualifiedSave();
  if (savedSlug && savedSlug.name) {
    this.canonicalSlugName = savedSlug.name;
    if (typeof (Team ?? TeamHandle)._getDbFieldName === 'function')
      this._changed.add((Team ?? TeamHandle)._getDbFieldName('canonicalSlugName'));
  }

  return this;
}

/**
 * Normalize a string into a slug-safe representation.
 *
 * @param str - Source string to convert
 * @returns Slugified name suitable for URLs
 */
function _generateSlugName(str: string): string {
  if (typeof str !== 'string')
    throw new Error('Source string is undefined or not a string.');

  const trimmed = str.trim();
  if (trimmed === '')
    throw new Error('Source string cannot be empty.');

  const slugName = unescapeHTML(trimmed)
    .trim()
    .toLowerCase()
    .replace(/[?&"″'`'<>:]/g, '')
    .replace(/[ _/]/g, '-')
    .replace(/-{2,}/g, '-');

  if (!slugName)
    throw new Error('Source string cannot be converted to a valid slug.');

  if (isUUID.v4(slugName))
    throw new Error('Source string cannot be a UUID.');

  return slugName;
}

registerTeamHandle({
  initializeModel: initializeTeamModel,
  additionalExports: {
    initializeTeamModel
  }
});

export default TeamHandle;
export { initializeTeamModel as initializeModel };
