import { ConstraintError, DuplicateSlugNameError } from '../dal/lib/errors.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { InferInstance } from '../dal/lib/model-manifest.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import types from '../dal/lib/type.ts';
import debug from '../util/debug.ts';

// Manifest-based model definition
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
  staticMethods: {
    /**
     * Look up a team slug by its name field.
     *
     * @param name - The slug name to retrieve
     * @returns The matching slug instance or null if none exists
     */
    async getByName(name: string) {
      try {
        return (await this.filterWhere({ name }).first()) as ModelInstance | null;
      } catch (error) {
        debug.error(`Error getting team slug by name '${name}'`);
        debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
        return null;
      }
    },
  },
  instanceMethods: {
    /**
     * Save the slug instance, translating uniqueness violations into domain
     * errors for callers.
     *
     * @returns This slug instance after persistence
     * @throws DuplicateSlugNameError when the slug name already exists
     */
    async qualifiedSave(this: ModelInstance): Promise<ModelInstance> {
      if (!this.createdOn) this.createdOn = new Date();

      try {
        return await this.save();
      } catch (error) {
        if (error instanceof ConstraintError && error.constraint === 'team_slugs_slug_unique') {
          throw new DuplicateSlugNameError(
            `Team slug '${this.name}' already exists`,
            String(this.name ?? this.slug),
            'team_slugs'
          );
        }
        throw error;
      }
    },
  },
} as const);

export type TeamSlugInstance = InferInstance<typeof teamSlugManifest>;

const TeamSlug = defineModel(teamSlugManifest);

export default TeamSlug;
