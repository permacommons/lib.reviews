import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

const teamSlugManifest = defineModelManifest({
  tableName: 'team_slugs',
  hasRevisions: false,
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
} as const);

type TeamSlugInstanceBase = InferInstance<typeof teamSlugManifest>;
type TeamSlugModelBase = InferConstructor<typeof teamSlugManifest>;

export interface TeamSlugStaticMethods {
  getByName(
    this: TeamSlugModelBase & TeamSlugStaticMethods,
    name: string
  ): Promise<(TeamSlugInstanceBase & TeamSlugInstanceMethods) | null>;
}

export interface TeamSlugInstanceMethods {
  qualifiedSave(
    this: TeamSlugInstanceBase & TeamSlugInstanceMethods
  ): Promise<TeamSlugInstanceBase & TeamSlugInstanceMethods>;
}

export type TeamSlugInstance = TeamSlugInstanceBase & TeamSlugInstanceMethods;
export type TeamSlugModel = TeamSlugModelBase & TeamSlugStaticMethods;

export function referenceTeamSlug(): TeamSlugModel {
  return referenceModel(teamSlugManifest) as TeamSlugModel;
}

export default teamSlugManifest;
