import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import { ConstraintError } from '../dal/lib/errors.ts';
import debug from '../util/debug.ts';
import thingSlugManifest, {
  reservedSlugs,
  type ThingSlugInstance,
  type ThingSlugInstanceMethods,
  type ThingSlugModel,
  type ThingSlugStaticMethods,
} from './manifests/thing-slug.ts';

const thingSlugStaticMethods = defineStaticMethods(thingSlugManifest, {
  /**
   * Get a thing slug by its name field.
   *
   * @param name - The slug name to look up
   * @returns The thing slug instance or null if not found
   */
  async getByName(name: string) {
    try {
      return (await this.filterWhere({ name }).first()) as ThingSlugInstance | null;
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error(`Error getting thing slug by name '${name}':`);
      debug.error({ error: serializedError });
      return null;
    }
  },
}) satisfies ThingSlugStaticMethods;

const thingSlugInstanceMethods = defineInstanceMethods(thingSlugManifest, {
  async qualifiedSave(): Promise<ThingSlugInstance | null> {
    const Model = this.constructor as ThingSlugModel;

    if (!this.baseName) {
      this.baseName = this.name;
    }

    if (!this.createdOn) {
      this.createdOn = new Date();
    }

    const baseName = this.baseName as string;
    const thingID = this.thingID as string;
    const slugName = String(this.name || '').toLowerCase();
    const forceQualifier = (reservedSlugs as readonly string[]).includes(slugName);

    const findByName = async (name: string): Promise<ThingSlugInstance | null> => {
      try {
        return (await Model.filterWhere({ name }).first()) as ThingSlugInstance | null;
      } catch (error) {
        debug.error(`Error checking for existing thing slug '${name}'`);
        debug.error({ error: error instanceof Error ? error : new Error(String(error)) });
        return null;
      }
    };

    const attemptSave = async (): Promise<ThingSlugInstance | null> => {
      try {
        if (typeof this.save !== 'function') {
          throw new Error('ThingSlug instance does not provide a save() method');
        }
        await this.save();
        return this;
      } catch (error) {
        if (error instanceof ConstraintError) {
          return null;
        }
        throw error;
      }
    };

    if (!forceQualifier) {
      const saved = await attemptSave();
      if (saved) {
        return saved;
      }
      const existing = await findByName(String(this.name));
      if (existing && existing.thingID === thingID) {
        return existing;
      }
    }

    const reusableSlug = (await Model.filterWhere({ baseName, thingID })
      .orderBy('createdOn', 'DESC')
      .first()) as ThingSlugInstance | null;
    if (reusableSlug) {
      return reusableSlug;
    }

    const latestQualifier = (await Model.filterWhere({ baseName })
      .orderBy('createdOn', 'DESC')
      .first()) as ThingSlugInstance | null;
    let nextQualifier = '2';
    if (latestQualifier?.qualifierPart) {
      const parsed = parseInt(latestQualifier.qualifierPart, 10);
      if (!Number.isNaN(parsed)) {
        nextQualifier = String(parsed + 1);
      }
    }

    while (true) {
      this.name = `${baseName}-${nextQualifier}`;
      this.slug = this.name;
      this.qualifierPart = nextQualifier;
      const saved = await attemptSave();
      if (saved) {
        return saved;
      }

      const existing = await findByName(String(this.name));
      if (existing && existing.thingID === thingID) {
        return existing;
      }

      const parsed = parseInt(nextQualifier, 10);
      nextQualifier = Number.isNaN(parsed) ? `${nextQualifier}2` : String(parsed + 1);
    }
  },
}) satisfies ThingSlugInstanceMethods;

const ThingSlug = defineModel(thingSlugManifest, {
  staticMethods: thingSlugStaticMethods,
  instanceMethods: thingSlugInstanceMethods,
  statics: {
    reservedSlugs,
  },
});

export type {
  ThingSlugInstance,
  ThingSlugInstanceMethods,
  ThingSlugModel,
  ThingSlugStaticMethods,
} from './manifests/thing-slug.ts';
export { reservedSlugs } from './manifests/thing-slug.ts';

export default ThingSlug;
