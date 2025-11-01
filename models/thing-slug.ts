import dal from '../dal/index.js';
import { ConstraintError } from '../dal/lib/errors.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import debug from '../util/debug.ts';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.js';

type PostgresModule = typeof import('../db-postgres.js');

type ThingSlugRecord = JsonObject;
type ThingSlugVirtual = JsonObject;
type ThingSlugInstance = ModelInstance<ThingSlugRecord, ThingSlugVirtual> & Record<string, any>;
type ThingSlugModel = ModelConstructor<ThingSlugRecord, ThingSlugVirtual, ThingSlugInstance> & Record<string, any>;

let postgresModulePromise: Promise<PostgresModule> | null = null;
async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise)
    postgresModulePromise = import('../db-postgres.js');
  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { types } = dal as unknown as { types: Record<string, any> };

let ThingSlug: ThingSlugModel | null = null;

// Reserved slugs that must never be used without qualification
const reservedSlugs = [
  'register', 'actions', 'signin', 'login', 'teams', 'user', 'new',
  'signout', 'logout', 'api', 'faq', 'static', 'terms'
] as const;

/**
 * Initialize the PostgreSQL ThingSlug model.
 *
 * @param dalInstance - Optional DAL instance for testing
 */
async function initializeThingSlugModel(dalInstance: Record<string, any> | null = null): Promise<ThingSlugModel | null> {
  const activeDAL = dalInstance ?? await getPostgresDAL();

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping ThingSlug model initialization');
    return null;
  }

  try {
    const schema = {
      id: types.string().uuid(4),
      thingID: types.string().uuid(4).required(true),
      slug: types.string().max(255).required(true),
      createdOn: types.date().default(() => new Date()),
      createdBy: types.string().uuid(4),
      baseName: types.string().max(255),
      name: types.string().max(255),
      qualifierPart: types.string().max(255)
    };

    const { model } = initializeModel<ThingSlugRecord, ThingSlugVirtual, ThingSlugInstance>({
      dal: activeDAL as any,
      baseTable: 'thing_slugs',
      schema,
      camelToSnake: {
        thingID: 'thing_id',
        createdOn: 'created_on',
        createdBy: 'created_by',
        baseName: 'base_name',
        qualifierPart: 'qualifier_part'
      },
      staticMethods: {
        getByName
      },
      instanceMethods: {
        qualifiedSave
      }
    });

    ThingSlug = model as ThingSlugModel;
    ThingSlug.reservedSlugs = reservedSlugs;

    debug.db('PostgreSQL ThingSlug model initialized');
    return ThingSlug;
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Failed to initialize PostgreSQL ThingSlug model:');
    debug.error({ error: serializedError });
    return null;
  }
}

const ThingSlugHandle = createAutoModelHandle<ThingSlugRecord, ThingSlugVirtual, ThingSlugInstance>(
  'thing_slugs',
  initializeThingSlugModel
) as ThingSlugModel;
ThingSlugHandle.reservedSlugs = reservedSlugs;

/**
 * Get the PostgreSQL ThingSlug model (initialize if needed).
 *
 * @param dalInstance - Optional DAL instance for testing
 */
async function getPostgresThingSlugModel(
  dalInstance: Record<string, any> | null = null
): Promise<ThingSlugModel | null> {
  ThingSlug = await initializeThingSlugModel(dalInstance);
  return ThingSlug;
}

/**
 * Get a thing slug by its name field.
 *
 * @param name - The slug name to look up
 * @returns The thing slug instance or null if not found
 */
async function getByName(this: ThingSlugModel, name: string): Promise<ThingSlugInstance | null> {
  try {
    return await this.filter({ name }).first();
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error(`Error getting thing slug by name '${name}':`);
    debug.error({ error: serializedError });
    return null;
  }
}

async function qualifiedSave(this: ThingSlugInstance): Promise<ThingSlugInstance | null> {
  const Model = this.constructor as ThingSlugModel;
  const dal = Model.dal as Record<string, any> | undefined;

  if (!dal) {
    throw new Error('ThingSlug DAL not initialized');
  }

  if (!this.baseName) {
    this.baseName = this.name;
  }

  if (!this.createdOn) {
    this.createdOn = new Date();
  }

  const baseName = this.baseName;
  const thingID = this.thingID;
  const forceQualifier = reservedSlugs.includes((this.name || '').toLowerCase());

  const findByName = async (name: string): Promise<ThingSlugInstance | null> => {
    const existing = await dal.query(
      `SELECT * FROM ${Model.tableName} WHERE name = $1 LIMIT 1`,
      [name]
    );
    return existing.rows.length ? (Model._createInstance(existing.rows[0]) as ThingSlugInstance) : null;
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
    const existing = await findByName(this.name);
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
    return Model._createInstance(result.rows[0]) as ThingSlugInstance;
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
  if (result.rows.length && result.rows[0].qualifier_part) {
    const parsed = parseInt(result.rows[0].qualifier_part, 10);
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

    const existing = await findByName(this.name);
    if (existing && existing.thingID === thingID) {
      return existing;
    }

    const parsed = parseInt(nextQualifier, 10);
    nextQualifier = Number.isNaN(parsed) ? `${nextQualifier}2` : String(parsed + 1);
  }
}

export default ThingSlugHandle;
export {
  initializeThingSlugModel as initializeModel,
  initializeThingSlugModel,
  getPostgresThingSlugModel,
  reservedSlugs
};
