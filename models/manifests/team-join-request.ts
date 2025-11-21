import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';

const { types } = dal;

const teamJoinRequestManifest = defineModelManifest({
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
});

export type TeamJoinRequestInstance = InferInstance<typeof teamJoinRequestManifest>;
export type TeamJoinRequestModel = InferConstructor<typeof teamJoinRequestManifest>;

export default teamJoinRequestManifest;
