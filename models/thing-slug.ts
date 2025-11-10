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
  async getByName(this: ThingSlugModel, name: string) {
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
  async qualifiedSave(this: ThingSlugInstance): Promise<ThingSlugInstance | null> {
    const Model = this.constructor as ThingSlugModel;
    const dal = Model.dal as {
      query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
    };

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
      const existing = await dal.query(`SELECT * FROM ${Model.tableName} WHERE name = $1 LIMIT 1`, [
        name,
      ]);
      return existing.rows.length
        ? (Model.createFromRow(existing.rows[0] as Record<string, unknown>) as ThingSlugInstance)
        : null;
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

    const reuseQuery = `
        SELECT *
        FROM ${Model.tableName}
        WHERE base_name = $1
          AND thing_id = $2
        ORDER BY created_on DESC
        LIMIT 1
      `;
    let result = await dal.query(reuseQuery, [baseName, thingID]);
    if (result.rows.length) {
      return Model.createFromRow(result.rows[0] as Record<string, unknown>) as ThingSlugInstance;
    }

    const latestQuery = `
        SELECT qualifier_part
        FROM ${Model.tableName}
        WHERE base_name = $1
        ORDER BY created_on DESC
        LIMIT 1
      `;
    result = await dal.query(latestQuery, [baseName]);
    let nextQualifier = '2';
    if (result.rows.length) {
      const row = result.rows[0] as { qualifier_part?: string };
      if (row.qualifier_part) {
        const parsed = parseInt(row.qualifier_part, 10);
        if (!Number.isNaN(parsed)) {
          nextQualifier = String(parsed + 1);
        }
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
