import { defineModel } from 'rev-dal/lib/create-model';
import userMetaManifest, {
  type UserMetaInstance,
  type UserMetaModel,
} from './manifests/user-meta.ts';

const UserMeta = defineModel(userMetaManifest);

export type { UserMetaInstance, UserMetaModel };

export default UserMeta;
