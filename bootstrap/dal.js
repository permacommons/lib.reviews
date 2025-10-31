/**
 * Centralized DAL Bootstrap (ESM)
 *
 * Provides a single entry point for initializing the PostgreSQL DAL,
 * running migrations, and registering all models exactly once during
 * application startup.
 */

import config from 'config';
import debug from '../util/debug.js';
import PostgresDAL from '../dal/index.js';

import userModule from '../models/user.js';
import userMetaModule from '../models/user-meta.js';
import teamModule from '../models/team.js';
import teamJoinRequestModule from '../models/team-join-request.js';
import teamSlugModule from '../models/team-slug.js';
import thingModule from '../models/thing.js';
import thingSlugModule from '../models/thing-slug.js';
import reviewModule from '../models/review.js';
import blogPostModule from '../models/blog-post.js';
import fileModule from '../models/file.js';
import inviteLinkModule from '../models/invite-link.js';

import { setBootstrapResolver } from '../dal/lib/model-handle.js';

const PostgresDALFactory = typeof PostgresDAL === 'function' ? PostgresDAL : PostgresDAL?.default;
if (typeof PostgresDALFactory !== 'function') {
  throw new TypeError('Postgres DAL factory not found. Ensure ../dal/index.js exports a function.');
}

const DEFAULT_MODEL_INITIALIZERS = [
  { key: 'users', initializer: userModule.initializeModel },
  { key: 'user_metas', initializer: userMetaModule.initializeModel },
  { key: 'teams', initializer: teamModule.initializeModel },
  { key: 'team_join_requests', initializer: teamJoinRequestModule.initializeModel },
  { key: 'team_slugs', initializer: teamSlugModule.initializeModel },
  { key: 'things', initializer: thingModule.initializeModel },
  { key: 'thing_slugs', initializer: thingSlugModule.initializeModel },
  { key: 'reviews', initializer: reviewModule.initializeModel },
  { key: 'blog_posts', initializer: blogPostModule.initializeModel },
  { key: 'files', initializer: fileModule.initializeModel },
  { key: 'invite_links', initializer: inviteLinkModule.initializeModel }
].filter(entry => typeof entry.initializer === 'function');

// Global DAL state
let globalDAL = null;
let initializationPromise = null;

function getPostgresConfig() {
  if (config?.postgres) {
    return config.postgres;
  }
  if (typeof config.get === 'function') {
    return config.get('postgres');
  }
  throw new Error('PostgreSQL configuration not found.');
}

async function tryReuseSharedDAL() {
  const dbModule = await import('../db-postgres.js');
  const exported = (dbModule && typeof dbModule.default === 'object')
    ? dbModule.default
    : dbModule;
  const { getPostgresDAL } = exported;
  if (typeof getPostgresDAL !== 'function') {
    throw new Error('getPostgresDAL is not available from db-postgres.js');
  }
  return getPostgresDAL();
}

/**
 * Initialize the DAL and register all models.
 * @param {Object|null} customConfig Optional custom configuration (primarily for tests).
 * @returns {Promise<import('../dal/lib/data-access-layer.js')>}
 */
export async function initializeDAL(customConfig = null) {
  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    let createdInternally = false;

    try {
      debug.db('Starting centralized DAL initialization...');

      if (customConfig) {
        globalDAL = PostgresDALFactory(customConfig);
        createdInternally = true;
        await globalDAL.connect();
        debug.db('DAL connected successfully');

        try {
          await globalDAL.migrate();
          debug.db('Database migrations completed');
        } catch (migrationError) {
          debug.db('Migration error (may be expected if DB already exists):', migrationError.message);
        }
      } else {
        try {
          globalDAL = await tryReuseSharedDAL();
          debug.db('Reusing existing PostgreSQL DAL instance');
        } catch (reuseError) {
          debug.db('Unable to reuse shared DAL instance, creating a new one:', reuseError.message);
          const dalConfig = getPostgresConfig();
          globalDAL = PostgresDALFactory(dalConfig);
          createdInternally = true;

          await globalDAL.connect();
          debug.db('DAL connected successfully');

          try {
            await globalDAL.migrate();
            debug.db('Database migrations completed');
          } catch (migrationError) {
            debug.db('Migration error (may be expected if DB already exists):', migrationError.message);
          }
        }
      }

      await registerAllModels(globalDAL);

      debug.db('DAL bootstrap completed successfully');
      return globalDAL;
    } catch (error) {
      debug.error('DAL initialization failed:', error);

      if (createdInternally && globalDAL) {
        try {
          await globalDAL.disconnect();
        } catch (disconnectError) {
          debug.error('Failed to clean up DAL after initialization error:', disconnectError);
        }
      }

      globalDAL = null;
      initializationPromise = null;
      throw error;
    }
  })();

  return initializationPromise;
}

/**
 * Register all application models with the DAL.
 * @param {Object} dal Data access layer instance.
 * @param {Array} initializers Model initializer descriptors.
 * @returns {Promise<Map<string, unknown>>}
 */
export async function registerAllModels(dal, initializers = DEFAULT_MODEL_INITIALIZERS) {
  debug.db('Registering all models...');

  const registered = new Map();

  for (const entry of initializers) {
    if (!entry) {
      continue;
    }

    let initializer = null;
    let key = null;

    if (typeof entry === 'function') {
      initializer = entry;
      key = entry.modelKey || entry.key || entry.name;
    } else if (typeof entry === 'object') {
      initializer = entry.initializer || entry.initialize || entry.init || entry.loader;
      key = entry.key || entry.name;
    }

    if (typeof initializer !== 'function') {
      continue;
    }

    try {
      const model = await initializer(dal);
      if (!model) {
        continue;
      }

      const canonicalKey = key || model.tableName || initializer.name;
      registered.set(canonicalKey, model);
      debug.db(`Registered model: ${canonicalKey}`);
    } catch (error) {
      const identifier = key || initializer.name || 'unknown';
      debug.error(`Failed to register model ${identifier}:`, error);
    }
  }

  debug.db(`Successfully registered ${registered.size} models`);
  return registered;
}

export function getDAL() {
  if (!globalDAL) {
    throw new Error('DAL not initialized. Call initializeDAL() first.');
  }
  return globalDAL;
}

export function getModel(tableName) {
  if (!globalDAL) {
    throw new Error('DAL not initialized. Call initializeDAL() first.');
  }

  try {
    return globalDAL.getModel(tableName);
  } catch (error) {
    if (/Model '.*' not found/.test(error?.message || '')) {
      return null;
    }
    throw error;
  }
}

export function getAllModels() {
  if (!globalDAL) {
    return new Map();
  }
  return globalDAL.getRegisteredModels();
}

export function isInitialized() {
  return globalDAL !== null;
}

export async function shutdown() {
  if (!globalDAL) {
    return;
  }

  try {
    const postgresModule = await import('../db-postgres.js');
    const exported = (postgresModule && typeof postgresModule.default === 'object')
      ? postgresModule.default
      : postgresModule;
    const sharedDAL = exported?.dal;

    if (sharedDAL && sharedDAL === globalDAL) {
      if (typeof exported.closeConnection === 'function') {
        await exported.closeConnection();
      }
    } else {
      await globalDAL.disconnect();
    }

    debug.db('DAL connection closed');
  } catch (error) {
    debug.error('Error closing DAL connection:', error);
  }

  globalDAL = null;
  initializationPromise = null;
}

function validateSchemaNamespace(schemaNamespace) {
  if (!schemaNamespace || typeof schemaNamespace !== 'string') {
    throw new Error('Schema namespace must be a non-empty string');
  }

  const schemaName = schemaNamespace.replace(/\.$/, '');

  if (!/^[a-z_][a-z0-9_-]*$/i.test(schemaName)) {
    throw new Error(
      `Invalid schema namespace: '${schemaNamespace}'. ` +
      'Must start with letter or underscore and contain only alphanumeric, underscore, or hyphen characters.'
    );
  }

  if (schemaName.length > 63) {
    throw new Error(`Schema namespace too long: ${schemaNamespace} (max 63 characters)`);
  }

  return schemaName;
}

export async function createTestHarness(options = {}) {
  const {
    configOverride = {},
    schemaName = null,
    schemaNamespace = null,
    autoMigrate = true,
    registerModels: shouldRegisterModels = true,
    modelInitializers = DEFAULT_MODEL_INITIALIZERS
  } = options;

  if (typeof config.has === 'function' && !config.has('postgres')) {
    throw new Error('PostgreSQL configuration not found. Cannot create test harness.');
  }

  const baseConfig = getPostgresConfig();
  const dalConfig = {
    ...baseConfig,
    allowExitOnIdle: true,
    ...configOverride
  };

  debug.db('Creating isolated test DAL harness...');
  const testDAL = PostgresDAL(dalConfig);
  await testDAL.connect();

  let activeSchema = schemaName || null;
  let activeNamespace = schemaNamespace || null;

  if (activeSchema) {
    const safeSchema = validateSchemaNamespace(activeSchema);

    await testDAL.query(`CREATE SCHEMA IF NOT EXISTS ${safeSchema}`);
    await testDAL.query(`SET search_path TO ${safeSchema}, public`);

    if (testDAL.pool?.on) {
      testDAL.pool.on('connect', client => {
        client.query(`SET search_path TO ${safeSchema}, public`).catch(() => {});
      });
    }

    activeNamespace = activeNamespace || `${safeSchema}.`;
  }

  if (activeNamespace) {
    testDAL.schemaNamespace = activeNamespace;
  }

  if (autoMigrate) {
    try {
      await testDAL.migrate();
    } catch (migrationError) {
      debug.db('Test harness migration error (may be expected if schema already exists):', migrationError.message);
    }
  }

  const previousState = {
    dal: globalDAL,
    promise: initializationPromise
  };

  globalDAL = testDAL;
  initializationPromise = Promise.resolve(testDAL);

  let registered = new Map();
  if (shouldRegisterModels) {
    registered = await registerAllModels(testDAL, modelInitializers);
  }

  async function cleanup({ dropSchema = true } = {}) {
    if (activeSchema && dropSchema) {
      try {
        const safeSchema = validateSchemaNamespace(activeSchema);
        await testDAL.query(`DROP SCHEMA IF EXISTS ${safeSchema} CASCADE`);
      } catch (error) {
        debug.error(`Failed to drop schema ${activeSchema}:`, error);
      }
    }

    try {
      await testDAL.disconnect();
    } catch (error) {
      debug.error('Failed to disconnect test DAL:', error);
    }

    globalDAL = previousState.dal;
    initializationPromise = previousState.promise;
  }

  return {
    dal: testDAL,
    schemaName: activeSchema,
    schemaNamespace: activeNamespace,
    registeredModels: registered,
    cleanup
  };
}

const bootstrapAPI = {
  initializeDAL,
  getDAL,
  getModel,
  getAllModels,
  isInitialized,
  shutdown,
  registerAllModels,
  createTestHarness
};

if (typeof setBootstrapResolver === 'function') {
  setBootstrapResolver(() => bootstrapAPI);
}

export default bootstrapAPI;
