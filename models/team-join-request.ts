import { createModel } from '../dal/lib/create-model.ts';
import types from '../dal/lib/type.ts';

// Manifest-based model definition
const teamJoinRequestManifest = {
  tableName: 'team_join_requests',
  hasRevisions: false,
  schema: {
    id: types.string().uuid(4),
    teamID: types.string().uuid(4).required(true),
    userID: types.string().uuid(4).required(true),
    status: types.string().default('pending'),
    requestDate: types.date(),
    requestMessage: types.string().max(500),
    rejectedBy: types.string().uuid(4),
    rejectionDate: types.date(),
    rejectionMessage: types.string(),
    rejectedUntil: types.date(),
  },
  camelToSnake: {
    teamID: 'team_id',
    userID: 'user_id',
    requestDate: 'request_date',
    requestMessage: 'request_message',
    rejectedBy: 'rejected_by',
    rejectionDate: 'rejection_date',
    rejectionMessage: 'rejection_message',
    rejectedUntil: 'rejected_until',
  },
} as const;

const TeamJoinRequest = createModel(teamJoinRequestManifest);

export default TeamJoinRequest;
