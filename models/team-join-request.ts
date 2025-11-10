import { defineModel } from '../dal/lib/create-model.ts';
import teamJoinRequestManifest from './manifests/team-join-request.ts';

const TeamJoinRequest = defineModel(teamJoinRequestManifest);

export type {
  TeamJoinRequestInstance,
  TeamJoinRequestModel,
} from './manifests/team-join-request.ts';

export default TeamJoinRequest;
