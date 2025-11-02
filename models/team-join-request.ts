import dal from '../dal/index.ts';
import { createAutoModelHandle } from '../dal/lib/model-handle.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.ts';
import { getPostgresDAL } from '../db-postgres.ts';
import debug from '../util/debug.ts';

type TeamJoinRequestRecord = JsonObject;
type TeamJoinRequestVirtual = JsonObject;
type TeamJoinRequestInstance = ModelInstance<TeamJoinRequestRecord, TeamJoinRequestVirtual> & Record<string, any>;
type TeamJoinRequestModel = ModelConstructor<TeamJoinRequestRecord, TeamJoinRequestVirtual, TeamJoinRequestInstance> & Record<string, any>;

const { types } = dal as unknown as { types: Record<string, any> };
let TeamJoinRequest: TeamJoinRequestModel | null = null;

/**
 * Initialize the PostgreSQL TeamJoinRequest model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if the DAL is unavailable
 */
export async function initializeTeamJoinRequestModel(dalInstance: Record<string, any> | null = null): Promise<TeamJoinRequestModel | null> {
  const activeDAL = dalInstance ?? await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping TeamJoinRequest model initialization');
    return null;
  }

  try {
    const schema = {
      id: types.string().uuid(4),
      teamID: types.string().uuid(4).required(true),
      userID: types.string().uuid(4).required(true),
      status: types.string().default('pending'),
      requestDate: types.date(),
      requestMessage: types.string().max(500),
      rejectedBy: types.string().uuid(4),
      rejectionDate: types.date(),
      rejectionMessage: types.string(),
      rejectedUntil: types.date()
    } as JsonObject;

    const { model, isNew } = initializeModel<TeamJoinRequestRecord, TeamJoinRequestVirtual, TeamJoinRequestInstance>({
      dal: activeDAL as any,
      baseTable: 'team_join_requests',
      schema,
      camelToSnake: {
        teamID: 'team_id',
        userID: 'user_id',
        requestDate: 'request_date',
        requestMessage: 'request_message',
        rejectedBy: 'rejected_by',
        rejectionDate: 'rejection_date',
        rejectionMessage: 'rejection_message',
        rejectedUntil: 'rejected_until'
      }
    });

    TeamJoinRequest = model as TeamJoinRequestModel;

    if (!isNew)
      return TeamJoinRequest;

    debug.db('PostgreSQL TeamJoinRequest model initialized (stub)');
    return TeamJoinRequest;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamJoinRequest model');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

const TeamJoinRequestHandle = createAutoModelHandle<TeamJoinRequestRecord, TeamJoinRequestVirtual, TeamJoinRequestInstance>(
  'team_join_requests',
  initializeTeamJoinRequestModel
);

export default TeamJoinRequestHandle;
export { initializeTeamJoinRequestModel as initializeModel };
