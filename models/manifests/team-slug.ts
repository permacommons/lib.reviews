import dal from '../../dal/index.ts';
import type { ManifestTypes } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';

const { types } = dal;

const teamSlugManifest = {
  tableName: 'team_slugs',
  hasRevisions: false as const,
  schema: {
    id: types.string().uuid(4),
    teamID: types.string().uuid(4).required(true),
    slug: types.string().max(255).required(true),
    createdOn: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4),
    name: types.string().max(255),
  },
  camelToSnake: {
    teamID: 'team_id',
    createdOn: 'created_on',
    createdBy: 'created_by',
  },
} as const satisfies ModelManifest;

type TeamSlugTypes = ManifestTypes<
  typeof teamSlugManifest,
  TeamSlugStaticMethods,
  TeamSlugInstanceMethods
>;

export interface TeamSlugStaticMethods {
  getByName(this: TeamSlugTypes['Model'], name: string): Promise<TeamSlugInstance | null>;
}

export interface TeamSlugInstanceMethods {
  qualifiedSave(this: TeamSlugTypes['Instance']): Promise<TeamSlugInstance>;
}

export type TeamSlugInstance = TeamSlugTypes['Instance'];
export type TeamSlugModel = TeamSlugTypes['Model'];

/**
 * Create a lazy reference to the TeamSlug model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed TeamSlug model constructor
 */
export function referenceTeamSlug(): TeamSlugModel {
  return referenceModel(teamSlugManifest) as TeamSlugModel;
}

export default teamSlugManifest;
