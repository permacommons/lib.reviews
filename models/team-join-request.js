import debug from '../util/debug.js';
import dal from '../dal/index.js';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import { getPostgresDAL } from '../db-postgres.js';

const { types } = dal;
let TeamJoinRequest = null;

/**
 * Initialize the PostgreSQL TeamJoinRequest model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeTeamJoinRequestModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

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
    };

    const { model, isNew } = initializeModel({
      dal: activeDAL,
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
    TeamJoinRequest = model;

    if (!isNew) {
      return TeamJoinRequest;
    }

    debug.db('PostgreSQL TeamJoinRequest model initialized (stub)');
    return TeamJoinRequest;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamJoinRequest model:', error);
    return null;
  }
}

const TeamJoinRequestHandle = createAutoModelHandle('team_join_requests', initializeTeamJoinRequestModel);

export default TeamJoinRequestHandle;
export { initializeTeamJoinRequestModel as initializeModel, initializeTeamJoinRequestModel };
