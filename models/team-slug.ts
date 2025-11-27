import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import { ConstraintError, DuplicateSlugNameError } from '../dal/lib/errors.ts';
import debug from '../util/debug.ts';
import teamSlugManifest, {
  type TeamSlugInstance,
  type TeamSlugInstanceMethods,
  type TeamSlugModel,
  type TeamSlugStaticMethods,
} from './manifests/team-slug.ts';

const teamSlugStaticMethods = defineStaticMethods(teamSlugManifest, {
  /**
   * Look up a team slug by its name field.
   *
   * @param name - The slug name to retrieve
   * @returns The matching slug instance or null if none exists
   */
  async getByName(name: string) {
    try {
      return (await this.filterWhere({ name }).first()) as TeamSlugInstance | null;
    } catch (error) {
      debug.error(`Error getting team slug by name '${name}'`);
      debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
      return null;
    }
  },
}) satisfies TeamSlugStaticMethods;

const teamSlugInstanceMethods = defineInstanceMethods(teamSlugManifest, {
  /**
   * Save the slug instance, translating uniqueness violations into domain
   * errors for callers.
   *
   * @returns This slug instance after persistence
   * @throws DuplicateSlugNameError when the slug name already exists
   */
  async qualifiedSave(): Promise<TeamSlugInstance> {
    if (!this.createdOn) this.createdOn = new Date();

    try {
      return (await this.save()) as TeamSlugInstance;
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
}) satisfies TeamSlugInstanceMethods;

const TeamSlug = defineModel(teamSlugManifest, {
  staticMethods: teamSlugStaticMethods,
  instanceMethods: teamSlugInstanceMethods,
});

export type {
  TeamSlugInstance,
  TeamSlugInstanceMethods,
  TeamSlugModel,
  TeamSlugStaticMethods,
} from './manifests/team-slug.ts';

export default TeamSlug;
