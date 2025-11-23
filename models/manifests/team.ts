import dal from '../../dal/index.ts';
import type { ManifestInstance, ManifestModel } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { StaticMethod } from '../../dal/lib/model-initializer.ts';
import type {
  InferConstructor,
  InferInstance,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
import type { InstanceMethod, ModelInstance } from '../../dal/lib/model-types.ts';
import languages from '../../locales/languages.ts';
import type { UserAccessContext, UserView } from './user.ts';

const { mlString, types } = dal;
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

function validateConfersPermissions(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Confers permissions must be an object');

  const validPermissions = ['show_error_details', 'translate'];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (validPermissions.includes(key) && typeof val !== 'boolean')
      throw new Error(`Permission ${key} must be a boolean`);
  }

  return true;
}

export interface TeamGetWithDataOptions {
  withMembers?: boolean;
  withModerators?: boolean;
  withJoinRequests?: boolean;
  withJoinRequestDetails?: boolean;
  withReviews?: boolean;
  reviewLimit?: number;
  reviewOffsetDate?: Date | null;
}

const teamManifest = {
  tableName: 'teams',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    name: mlString.getSafeTextSchema({ maxLength: 100 }),
    motto: mlString.getSafeTextSchema({ maxLength: 200 }),
    description: mlString.getRichTextSchema(),
    rules: mlString.getRichTextSchema(),
    modApprovalToJoin: types.boolean().default(false),
    onlyModsCanBlog: types.boolean().default(false),
    createdBy: types.string().uuid(4).required(true),
    createdOn: types.date().required(true),
    canonicalSlugName: types.string(),
    originalLanguage: types.string().max(4).validator(isValidLanguage),
    confersPermissions: types.object().validator(validateConfersPermissions),
    reviewOffsetDate: types.virtual<Date>().default(null),
    userIsFounder: types.virtual().default(false),
    userIsMember: types.virtual().default(false),
    userIsModerator: types.virtual().default(false),
    userCanBlog: types.virtual().default(false),
    userCanJoin: types.virtual().default(false),
    userCanLeave: types.virtual().default(false),
    userCanEdit: types.virtual().default(false),
    userCanDelete: types.virtual().default(false),
    members: types.virtual<UserView[]>().default(undefined),
    moderators: types.virtual<UserView[]>().default(undefined),
    joinRequests: types.virtual<ModelInstance[]>().default(undefined),
    reviews: types.virtual<ModelInstance[]>().default(undefined),
    reviewCount: types.virtual<number>().default(undefined),
    urlID: types.virtual().default(function (this: InferInstance<typeof teamManifest>) {
      const slugName =
        typeof this.getValue === 'function'
          ? this.getValue('canonicalSlugName')
          : this.canonicalSlugName;
      return slugName ? encodeURIComponent(String(slugName)) : this.id;
    }),
  },
  camelToSnake: {
    modApprovalToJoin: 'mod_approval_to_join',
    onlyModsCanBlog: 'only_mods_can_blog',
    createdBy: 'created_by',
    createdOn: 'created_on',
    canonicalSlugName: 'canonical_slug_name',
    originalLanguage: 'original_language',
    confersPermissions: 'confers_permissions',
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
        targetForeignKey: 'user_id',
      },
      cardinality: 'many',
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
        targetForeignKey: 'user_id',
      },
      cardinality: 'many',
    },
  ],
} as const satisfies ModelManifest;

type TeamInstanceBase = InferInstance<typeof teamManifest>;
type TeamModelBase = InferConstructor<typeof teamManifest>;

export interface TeamInstanceMethods extends Record<string, InstanceMethod<TeamInstanceBase>> {
  populateUserInfo(
    this: TeamInstanceBase & TeamInstanceMethods,
    user: ModelInstance | UserAccessContext | null | undefined
  ): void;
  updateSlug(
    this: TeamInstanceBase & TeamInstanceMethods,
    userID: string,
    language?: string | null
  ): Promise<TeamInstance>;
}

export interface TeamStaticMethods extends Record<string, StaticMethod> {
  getWithData(
    this: TeamModelBase & TeamStaticMethods,
    id: string,
    options?: TeamGetWithDataOptions
  ): Promise<TeamInstance>;
}

export type TeamInstance = ManifestInstance<typeof teamManifest, TeamInstanceMethods>;
export type TeamModel = ManifestModel<typeof teamManifest, TeamStaticMethods, TeamInstanceMethods>;

/**
 * Create a typed reference to the Team model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceTeam(): TeamModel {
  return referenceModel(teamManifest) as TeamModel;
}

export default teamManifest;
