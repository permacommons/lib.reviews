import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import { ConstraintError } from '../dal/lib/errors.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import types from '../dal/lib/type.ts';
import debug from '../util/debug.ts';

// Reserved slugs that must never be used without qualification
const reservedSlugs = [
  'register',
  'actions',
  'signin',
  'login',
  'teams',
  'user',
  'new',
  'signout',
  'logout',
  'api',
  'faq',
  'static',
  'terms',
] as const;

// Manifest-based model definition
const thingSlugManifest = defineModelManifest({
  tableName: 'thing_slugs',
  hasRevisions: false,
  schema: {
    id: types.string().uuid(4),
    thingID: types.string().uuid(4).required(true),
    slug: types.string().max(255).required(true),
    createdOn: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4),
    baseName: types.string().max(255),
    name: types.string().max(255),
    qualifierPart: types.string().max(255),
  },
  camelToSnake: {
    thingID: 'thing_id',
    createdOn: 'created_on',
    createdBy: 'created_by',
    baseName: 'base_name',
    qualifierPart: 'qualifier_part',
  },
  staticMethods: {
    /**
     * Get a thing slug by its name field.
     *
     * @param name - The slug name to look up
     * @returns The thing slug instance or null if not found
     */
    async getByName(name: string) {
      try {
        return (await this.filterWhere({ name }).first()) as ModelInstance | null;
      } catch (error) {
        const serializedError = error instanceof Error ? error : new Error(String(error));
        debug.error(`Error getting thing slug by name '${name}':`);
        debug.error({ error: serializedError });
        return null;
      }
    },
  },
  instanceMethods: {
    async qualifiedSave(this: ModelInstance): Promise<ModelInstance | null> {
      const Model = this.constructor as typeof ThingSlug;
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

      const findByName = async (name: string): Promise<ModelInstance | null> => {
        const existing = await dal.query(
          `SELECT * FROM ${Model.tableName} WHERE name = $1 LIMIT 1`,
          [name]
        );
        return existing.rows.length
          ? (Model.createFromRow(existing.rows[0] as Record<string, unknown>) as ModelInstance)
          : null;
      };

      const attemptSave = async (): Promise<ModelInstance | null> => {
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
        return Model.createFromRow(result.rows[0] as Record<string, unknown>) as ModelInstance;
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
  },
} as const);

export type ThingSlugInstance = InferInstance<typeof thingSlugManifest>;
export type ThingSlugModel = InferConstructor<typeof thingSlugManifest>;

const ThingSlug = defineModel(thingSlugManifest, {
  statics: {
    reservedSlugs,
  },
});

export default ThingSlug;
export { reservedSlugs };
