import dal from 'rev-dal';
import type { ManifestBundle, ManifestInstance } from 'rev-dal/lib/create-model';
import { referenceModel } from 'rev-dal/lib/model-handle';
import type { InferInstance, ModelManifest } from 'rev-dal/lib/model-manifest';
import type { ModelInstance } from 'rev-dal/lib/model-types';
import languages from '../../locales/languages.ts';
import type { ReviewInstance } from './review.ts';
import type { TeamJoinRequestInstance } from './team-join-request.ts';
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
    // Note: relation fields (members, moderators, joinRequests, reviews) are typed via intersection pattern
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

export type TeamRelations = {
  members?: UserView[];
  moderators?: UserView[];
  joinRequests?: TeamJoinRequestInstance[];
  reviews?: ReviewInstance[];
};

type TeamInstanceMethodsMap = {
  populateUserInfo(user: ModelInstance | UserAccessContext | null | undefined): void;
  updateSlug(
    userID: string,
    language?: string | null
  ): Promise<TeamInstanceBase & TeamInstanceMethodsMap>;
};

type TeamInstanceBase = ManifestInstance<typeof teamManifest, TeamInstanceMethodsMap> &
  TeamRelations;

type TeamStaticMethodsMap = {
  getWithData(
    id: string,
    options?: TeamGetWithDataOptions
  ): Promise<TeamInstanceBase & TeamInstanceMethodsMap>;
};

type TeamTypes = ManifestBundle<
  typeof teamManifest,
  TeamRelations,
  TeamStaticMethodsMap,
  TeamInstanceMethodsMap
>;

// Relation-backed fields stay optional since they are only populated when loaded
export type TeamInstance = TeamTypes['Instance'];
export type TeamInstanceMethods = TeamTypes['InstanceMethods'];
export type TeamStaticMethods = TeamTypes['StaticMethods'];
export type TeamModel = TeamTypes['Model'];

/**
 * Create a typed reference to the Team model for use in cross-model dependencies.
 * Avoids circular imports by only importing the manifest, not the full implementation.
 */
export function referenceTeam(): TeamModel {
  return referenceModel(teamManifest) as TeamModel;
}

export default teamManifest;
