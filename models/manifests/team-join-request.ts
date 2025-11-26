import dal from '../../dal/index.ts';
import type { ManifestTypes } from '../../dal/lib/create-model.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';

const { types } = dal;

const teamJoinRequestManifest = {
  tableName: 'team_join_requests',
  hasRevisions: false as const,
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
} as const satisfies ModelManifest;

type TeamJoinRequestTypes = ManifestTypes<typeof teamJoinRequestManifest>;

export type TeamJoinRequestInstance = TeamJoinRequestTypes['Instance'];
export type TeamJoinRequestModel = TeamJoinRequestTypes['Model'];

export default teamJoinRequestManifest;
