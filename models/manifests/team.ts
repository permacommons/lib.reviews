import dal from '../../dal/index.ts';
import type { ManifestExports } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';
import type { ModelInstance } from '../../dal/lib/model-types.ts';
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
    urlID: types.virtual().default(function (this: TeamTypes['BaseInstance']) {
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

type TeamRelations = {
  members?: UserView[];
  moderators?: UserView[];
  joinRequests?: TeamJoinRequestInstance[];
  reviews?: ReviewInstance[];
};

type TeamBaseTypes = ManifestExports<typeof teamManifest, { relations: TeamRelations }>;

type TeamInstanceMethodsMap = {
  populateUserInfo(user: ModelInstance | UserAccessContext | null | undefined): void;
  updateSlug(
    userID: string,
    language?: string | null
  ): Promise<TeamBaseTypes['Instance'] & TeamInstanceMethodsMap>;
};

type TeamTypes = ManifestExports<
  typeof teamManifest,
  {
    relations: TeamRelations;
    statics: {
      getWithData(
        id: string,
        options?: TeamGetWithDataOptions
      ): Promise<TeamBaseTypes['Instance'] & TeamInstanceMethodsMap>;
    };
    instances: TeamInstanceMethodsMap;
  }
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
