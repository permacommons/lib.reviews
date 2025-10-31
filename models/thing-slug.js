import dal from '../dal/index.js';
import { ConstraintError } from '../dal/lib/errors.js';
import { initializeModel } from '../dal/lib/model-initializer.js';
import debug from '../util/debug.js';
import { createAutoModelHandle } from '../dal/lib/model-handle.js';

let postgresModulePromise;
async function loadDbPostgres() {
  if (!postgresModulePromise) {
    postgresModulePromise = import('../db-postgres.js');
  }
  return postgresModulePromise;
}

async function getPostgresDAL() {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { types } = dal;

let ThingSlug = null;

// Reserved slugs that must never be used without qualification
const reservedSlugs = [
  'register', 'actions', 'signin', 'login', 'teams', 'user', 'new',
  'signout', 'logout', 'api', 'faq', 'static', 'terms'
];

/**
 * Initialize the PostgreSQL ThingSlug model
 * @param {DataAccessLayer} dal - Optional DAL instance for testing
 */
async function initializeThingSlugModel(dal = null) {
  const activeDAL = dal || await getPostgresDAL();

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

    const { model } = initializeModel({
      dal: activeDAL,
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

    ThingSlug = model;
    ThingSlug.reservedSlugs = reservedSlugs;

    debug.db('PostgreSQL ThingSlug model initialized');
    return ThingSlug;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL ThingSlug model:', error);
    return null;
  }
}

const ThingSlugHandle = createAutoModelHandle('thing_slugs', initializeThingSlugModel);
ThingSlugHandle.reservedSlugs = reservedSlugs;

/**
 * Get the PostgreSQL ThingSlug model (initialize if needed)
 * @param {DataAccessLayer|null} [dal] - Optional DAL instance for testing
 */
async function getPostgresThingSlugModel(dal = null) {
  ThingSlug = await initializeThingSlugModel(dal);
  return ThingSlug;
}

/**
 * Get a thing slug by its name field.
 *
 * @param {string} name - The slug name to look up
 * @returns {Promise<ThingSlug|null>} The thing slug instance or null if not found
 * @static
 * @memberof ThingSlug
 */
async function getByName(name) {
  try {
    return await this.filter({ name }).first();
  } catch (error) {
    debug.error(`Error getting thing slug by name '${name}':`, error);
    return null;
  }
}

async function qualifiedSave() {
  const Model = this.constructor;
  const dal = Model.dal;

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

  const findByName = async name => {
    const existing = await dal.query(
      `SELECT * FROM ${Model.tableName} WHERE name = $1 LIMIT 1`,
      [name]
    );
    return existing.rows.length ? Model._createInstance(existing.rows[0]) : null;
  };

  const attemptSave = async () => {
    try {
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
    return Model._createInstance(result.rows[0]);
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
