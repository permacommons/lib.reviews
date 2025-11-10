import { defineModel } from '../dal/lib/create-model.ts';
import userMetaManifest, {
  type UserMetaInstance,
  type UserMetaModel,
} from './manifests/user-meta.ts';

const UserMeta = defineModel(userMetaManifest);

export type { UserMetaInstance, UserMetaModel };

export default UserMeta;
