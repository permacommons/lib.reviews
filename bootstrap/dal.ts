/**
 * Centralized DAL bootstrap (ESM)
 *
 * Coordinates a single initialization pass for the PostgreSQL DAL so that
 * migrations, model registration, and shared handles are all wired up exactly
 * once during application startup.
 */

import type { PostgresConfig } from 'config';

import config from 'config';
import PostgresDAL from '../dal/index.ts';
import { setBootstrapResolver } from '../dal/lib/model-handle.ts';

import type { DataAccessLayer, JsonObject, ModelConstructor } from '../dal/lib/model-types.ts';
import '../models/blog-post.ts';
import '../models/file.ts';
import '../models/invite-link.ts';
import '../models/review.ts';
import '../models/team.ts';
import '../models/team-join-request.ts';
import '../models/team-slug.ts';
import '../models/thing.ts';
import '../models/thing-slug.ts';
import '../models/user.ts';
import '../models/user-meta.ts';
import debug from '../util/debug.ts';

type ModelInitializer = (dal: DataAccessLayer) => Promise<void>;

const DEFAULT_MODEL_INITIALIZERS: ModelInitializer[] = [];

const PostgresDALFactoryValue =
  typeof PostgresDAL === 'function' ? PostgresDAL : (PostgresDAL as { default?: unknown }).default;

if (typeof PostgresDALFactoryValue !== 'function') {
  throw new TypeError('Postgres DAL factory not found. Ensure ../dal/index.ts exports a function.');
}

const PostgresDALFactory = PostgresDALFactoryValue as (
  config?: Partial<PostgresConfig> & JsonObject
) => DataAccessLayer;

// Models now register themselves via manifest side effects on import.

let globalDAL: DataAccessLayer | null = null;
let initializationPromise: Promise<DataAccessLayer> | null = null;

/**
 * Look up the postgres configuration from the runtime config module. Supports
 * both direct property access and `config.get` to match production settings.
 * @returns The normalized postgres configuration object.
 */
function getPostgresConfig(): Partial<PostgresConfig> & JsonObject {
  if ((config as JsonObject)?.postgres) {
    return (config as JsonObject).postgres as Partial<PostgresConfig> & JsonObject;
  }
  if (typeof (config as { get?: (key: string) => unknown }).get === 'function') {
    return ((config as { get: (key: string) => unknown }).get('postgres') ??
      {}) as Partial<PostgresConfig> & JsonObject;
  }
  throw new Error('PostgreSQL configuration not found.');
}

/**
 * Reuse the shared DAL export from `db-postgres` when a caller already
 * connected to the database. Prevents duplicate pools within a running
 * application instance.
 * @returns The shared data access layer instance provided by `db-postgres`.
 */
async function tryReuseSharedDAL(): Promise<DataAccessLayer> {
  const dbModule = await import('../db-postgres.ts');
  const exported =
    dbModule && typeof dbModule.default === 'object'
      ? (dbModule.default as JsonObject)
      : (dbModule as JsonObject);
  const getPostgresDAL = exported?.getPostgresDAL as
    | (() => Promise<DataAccessLayer> | DataAccessLayer)
    | undefined;
  if (typeof getPostgresDAL !== 'function') {
    throw new Error('getPostgresDAL is not available from db-postgres.ts');
  }
  const dal = await getPostgresDAL();
  return dal as DataAccessLayer;
}

/**
 * Initialize the shared PostgreSQL DAL, optionally honoring a configuration
 * override. Runs migrations exactly once and registers models after a
 * successful connection.
 * @param customConfig Optional configuration overrides, typically used for tests.
 * @returns Resolves with the shared data access layer instance.
 */
export async function initializeDAL(
  customConfig: (Partial<PostgresConfig> & JsonObject) | null = null
): Promise<DataAccessLayer> {
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
          debug.db(
            'Migration error (may be expected if DB already exists):',
            (migrationError as Error).message
          );
        }
      } else {
        try {
          globalDAL = await tryReuseSharedDAL();
          debug.db('Reusing existing PostgreSQL DAL instance');
        } catch (reuseError) {
          debug.db(
            'Unable to reuse shared DAL instance, creating a new one:',
            (reuseError as Error).message
          );
          const dalConfig = getPostgresConfig();
          globalDAL = PostgresDALFactory(dalConfig);
          createdInternally = true;

          await globalDAL.connect();
          debug.db('DAL connected successfully');

          try {
            await globalDAL.migrate();
            debug.db('Database migrations completed');
          } catch (migrationError) {
            debug.db(
              'Migration error (may be expected if DB already exists):',
              (migrationError as Error).message
            );
          }
        }
      }

      await registerAllModels(globalDAL);

      debug.db('DAL bootstrap completed successfully');
      return globalDAL;
    } catch (error) {
      const errorMessage = `DAL initialization failed: ${error instanceof Error ? error.message : String(error)}`;
      debug.error(errorMessage);
      if (error instanceof Error) {
        debug.error({ error });
      }

      if (createdInternally && globalDAL) {
        try {
          await globalDAL.disconnect();
        } catch (disconnectError) {
          const cleanupMessage = `Failed to clean up DAL after initialization error: ${disconnectError instanceof Error ? disconnectError.message : String(disconnectError)}`;
          debug.error(cleanupMessage);
          if (disconnectError instanceof Error) {
            debug.error({ error: disconnectError });
          }
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
 * Register the provided model initializers with the given DAL instance.
 * @param dal Connected data access layer that owns the registration.
 * @param initializers Collection of initializer descriptors to invoke.
 * @returns Map of registry keys to the constructors they registered.
 */
export async function registerAllModels(
  dal: DataAccessLayer,
  initializers: ModelInitializer[] = DEFAULT_MODEL_INITIALIZERS
): Promise<Map<string, ModelConstructor>> {
  debug.db('Registering manifest-based models...');

  for (const initializer of initializers) {
    if (typeof initializer !== 'function') {
      continue;
    }
    try {
      await initializer(dal);
    } catch (error) {
      const name = (initializer as { name?: string })?.name ?? '<anonymous>';
      const message = `Model initializer "${name}" failed: ${error instanceof Error ? error.message : String(error)}`;
      debug.error(message);
      if (error instanceof Error) {
        debug.error({ error });
      }
    }
  }

  try {
    const { initializeManifestModels } = await import('../dal/lib/create-model.ts');
    initializeManifestModels(dal);
    debug.db('Initialized manifest-based models');
  } catch (error) {
    debug.error('Failed to initialize manifest-based models');
    if (error instanceof Error) {
      debug.error({ error });
    }
  }

  const registered = dal.getRegisteredModels();
  debug.db(`Manifest registry contains ${registered.size} models`);
  return registered;
}

/**
 * Access the shared DAL instance after initialization has completed.
 * @returns The globally cached data access layer.
 */
export function getDAL(): DataAccessLayer {
  if (!globalDAL) {
    throw new Error('DAL not initialized. Call initializeDAL() first.');
  }
  return globalDAL;
}

/**
 * Fetch a registered model constructor by table name without throwing when it
 * is absent.
 * @param tableName Table name or registry key to look up.
 * @returns The registered constructor or null when missing.
 */
export function getModel<TRecord extends JsonObject, TVirtual extends JsonObject = JsonObject>(
  tableName: string
): ModelConstructor<TRecord, TVirtual> | null {
  if (!globalDAL) {
    throw new Error('DAL not initialized. Call initializeDAL() first.');
  }

  try {
    return globalDAL.getModel<TRecord, TVirtual>(tableName);
  } catch (error) {
    if (/Model '.*' not found/.test((error as Error)?.message ?? '')) {
      return null;
    }
    throw error;
  }
}

/**
 * Retrieve the map of registered model constructors keyed by registry key.
 * @returns Snapshot of the DAL's registered models.
 */
export function getAllModels(): Map<string, ModelConstructor> {
  if (!globalDAL) {
    return new Map();
  }
  return globalDAL.getRegisteredModels();
}

/**
 * Determine whether the bootstrap already connected the DAL.
 * @returns True when initialization finished successfully.
 */
export function isInitialized(): boolean {
  return globalDAL !== null;
}

/**
 * Dispose the shared DAL connection, attempting to route the shutdown through
 * the shared postgres module when possible so pooled clients are cleaned up.
 */
export async function shutdown(): Promise<void> {
  if (!globalDAL) {
    return;
  }

  try {
    const postgresModule = await import('../db-postgres.ts');
    const exported =
      postgresModule && typeof postgresModule.default === 'object'
        ? (postgresModule.default as JsonObject)
        : (postgresModule as JsonObject);
    const sharedDAL = exported?.dal as DataAccessLayer | undefined;

    if (sharedDAL && sharedDAL === globalDAL) {
      const closeConnection = exported?.closeConnection as (() => Promise<void>) | undefined;
      if (typeof closeConnection === 'function') {
        await closeConnection();
      }
    } else {
      await globalDAL.disconnect();
    }

    debug.db('DAL connection closed');
  } catch (error) {
    const shutdownMessage = `Error closing DAL connection: ${error instanceof Error ? error.message : String(error)}`;
    debug.error(shutdownMessage);
    if (error instanceof Error) {
      debug.error({ error });
    }
  }

  globalDAL = null;
  initializationPromise = null;
}

/**
 * Validate that an isolated schema name is safe to use for temporary test
 * environments and strip trailing periods when present.
 * @param schemaNamespace Requested schema namespace, optionally with a trailing period.
 * @returns Sanitized schema identifier without a trailing period.
 */
function validateSchemaNamespace(schemaNamespace: string): string {
  if (!schemaNamespace || typeof schemaNamespace !== 'string') {
    throw new Error('Schema namespace must be a non-empty string');
  }

  const schemaName = schemaNamespace.replace(/\.$/, '');

  if (!/^[a-z_][a-z0-9_-]*$/i.test(schemaName)) {
    throw new Error(
      `Invalid schema namespace: '${schemaNamespace}'. Must start with letter or underscore and contain only alphanumeric, underscore, or hyphen characters.`
    );
  }

  if (schemaName.length > 63) {
    throw new Error(`Schema namespace too long: ${schemaNamespace} (max 63 characters)`);
  }

  return schemaName;
}

interface TestHarnessOptions {
  configOverride?: Partial<PostgresConfig> & JsonObject;
  schemaName?: string | null;
  schemaNamespace?: string | null;
  autoMigrate?: boolean;
  registerModels?: boolean;
  modelInitializers?: ModelInitializer[];
}

/**
 * Create an isolated DAL instance for integration tests with optional schema
 * isolation and automatic model registration.
 * @param options Customization flags that control schema names, config overrides, and registration.
 * @returns Handle to the isolated DAL along with helpers for cleanup.
 */
export async function createTestHarness(options: TestHarnessOptions = {}): Promise<{
  dal: DataAccessLayer;
  schemaName: string | null;
  schemaNamespace: string | null;
  registeredModels: Map<string, ModelConstructor>;
  cleanup: (options?: { dropSchema?: boolean }) => Promise<void>;
}> {
  const {
    configOverride = {},
    schemaName = null,
    schemaNamespace = null,
    autoMigrate = true,
    registerModels: shouldRegisterModels = true,
    modelInitializers = DEFAULT_MODEL_INITIALIZERS,
  } = options;

  if (
    typeof (config as { has?: (key: string) => boolean }).has === 'function' &&
    !(config as { has: (key: string) => boolean }).has('postgres')
  ) {
    throw new Error('PostgreSQL configuration not found. Cannot create test harness.');
  }

  const baseConfig = getPostgresConfig();
  const dalConfig = {
    ...baseConfig,
    allowExitOnIdle: true,
    ...configOverride,
  } as Partial<PostgresConfig> & JsonObject;

  debug.db('Creating isolated test DAL harness...');
  const testDAL = PostgresDALFactory(dalConfig) as DataAccessLayer;
  await testDAL.connect();

  let activeSchema = schemaName || null;
  let activeNamespace = schemaNamespace || null;

  if (activeSchema) {
    const safeSchema = validateSchemaNamespace(activeSchema);

    await testDAL.query(`CREATE SCHEMA IF NOT EXISTS ${safeSchema}`);
    await testDAL.query(`SET search_path TO ${safeSchema}, public`);

    if (testDAL.pool && typeof testDAL.pool.on === 'function') {
      testDAL.pool.on('connect', (client: { query: (sql: string) => Promise<unknown> }) => {
        client.query(`SET search_path TO ${safeSchema}, public`).catch(() => {
          // Intentionally ignore errors - this is a best-effort schema setting
        });
      });
    }

    activeNamespace = activeNamespace || `${safeSchema}.`;
  }

  if (activeNamespace) {
    (testDAL as DataAccessLayer & { schemaNamespace?: string }).schemaNamespace = activeNamespace;
  }

  if (autoMigrate) {
    try {
      await testDAL.migrate();
    } catch (migrationError) {
      debug.db(
        'Test harness migration error (may be expected if schema already exists):',
        (migrationError as Error).message
      );
    }
  }

  const previousState = {
    dal: globalDAL,
    promise: initializationPromise,
  };

  globalDAL = testDAL;
  initializationPromise = Promise.resolve(testDAL);

  let registered = new Map<string, ModelConstructor>();
  if (shouldRegisterModels) {
    registered = await registerAllModels(testDAL, modelInitializers);
  }

  async function cleanup({ dropSchema = true } = {}): Promise<void> {
    if (activeSchema && dropSchema) {
      try {
        const safeSchema = validateSchemaNamespace(activeSchema);
        await testDAL.query(`DROP SCHEMA IF EXISTS ${safeSchema} CASCADE`);
      } catch (error) {
        const dropMessage = `Failed to drop schema ${activeSchema}: ${error instanceof Error ? error.message : String(error)}`;
        debug.error(dropMessage);
        if (error instanceof Error) {
          debug.error({ error });
        }
      }
    }

    try {
      await testDAL.disconnect();
    } catch (error) {
      const disconnectMessage = `Failed to disconnect test DAL: ${error instanceof Error ? error.message : String(error)}`;
      debug.error(disconnectMessage);
      if (error instanceof Error) {
        debug.error({ error });
      }
    }

    globalDAL = previousState.dal;
    initializationPromise = previousState.promise;
  }

  return {
    dal: testDAL,
    schemaName: activeSchema,
    schemaNamespace: activeNamespace,
    registeredModels: registered,
    cleanup,
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
  createTestHarness,
};

if (typeof setBootstrapResolver === 'function') {
  setBootstrapResolver(() => bootstrapAPI);
}

export default bootstrapAPI;
