import dal from '../dal/index.js';
import { ConstraintError, DuplicateSlugNameError } from '../dal/lib/errors.js';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.js';
import { getPostgresDAL } from '../db-postgres.js';
import debug from '../util/debug.ts';

type TeamSlugRecord = JsonObject;
type TeamSlugVirtual = JsonObject;
type TeamSlugInstance = ModelInstance<TeamSlugRecord, TeamSlugVirtual> & Record<string, any>;
type TeamSlugModel = ModelConstructor<TeamSlugRecord, TeamSlugVirtual, TeamSlugInstance> & Record<string, any>;

const { types } = dal as unknown as { types: Record<string, any> };
let TeamSlug: TeamSlugModel | null = null;

/**
 * Initialize the PostgreSQL TeamSlug model.
 *
 * @param dalInstance - Optional DAL instance for testing
 * @returns The initialized model or null if the DAL is unavailable
 */
export async function initializeTeamSlugModel(dalInstance: Record<string, any> | null = null): Promise<TeamSlugModel | null> {
  const activeDAL = dalInstance ?? await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping TeamSlug model initialization');
    return null;
  }

  try {
    const schema = {
      id: types.string().uuid(4),
      teamID: types.string().uuid(4).required(true),
      slug: types.string().max(255).required(true),
      createdOn: types.date().default(() => new Date()),
      createdBy: types.string().uuid(4),
      name: types.string().max(255)
    } as JsonObject;

    const { model, isNew } = initializeModel<TeamSlugRecord, TeamSlugVirtual, TeamSlugInstance>({
      dal: activeDAL as any,
      baseTable: 'team_slugs',
      schema,
      camelToSnake: {
        teamID: 'team_id',
        createdOn: 'created_on',
        createdBy: 'created_by'
      },
      staticMethods: {
        getByName
      },
      instanceMethods: {
        qualifiedSave
      }
    });

    TeamSlug = model as TeamSlugModel;

    if (!isNew)
      return TeamSlug;

    debug.db('PostgreSQL TeamSlug model initialized');
    return TeamSlug;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL TeamSlug model');
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

const TeamSlugHandle = createAutoModelHandle<TeamSlugRecord, TeamSlugVirtual, TeamSlugInstance>(
  'team_slugs',
  initializeTeamSlugModel
);

/**
 * Look up a team slug by its name field.
 *
 * @param name - The slug name to retrieve
 * @returns The matching slug instance or null if none exists
 */
async function getByName(this: TeamSlugModel, name: string): Promise<TeamSlugInstance | null> {
  try {
    return await this.filter({ name }).first() as TeamSlugInstance | null;
  } catch (error) {
    debug.error(`Error getting team slug by name '${name}'`);
    debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
    return null;
  }
}

/**
 * Save the slug instance, translating uniqueness violations into domain
 * errors for callers.
 *
 * @returns This slug instance after persistence
 * @throws DuplicateSlugNameError when the slug name already exists
 */
async function qualifiedSave(this: TeamSlugInstance): Promise<TeamSlugInstance> {
  if (!this.createdOn)
    this.createdOn = new Date();

  try {
    return await this.save();
  } catch (error) {
    if (error instanceof ConstraintError && error.constraint === 'team_slugs_slug_unique') {
      throw new DuplicateSlugNameError(
        `Team slug '${this.name}' already exists`,
        this.name ?? this.slug,
        'team_slugs'
      );
    }
    throw error;
  }
}

export default TeamSlugHandle;
export { initializeTeamSlugModel as initializeModel };
