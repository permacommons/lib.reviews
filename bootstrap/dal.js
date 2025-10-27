'use strict';

/**
 * Centralized DAL Bootstrap
 * 
 * This module provides a single entry point for initializing the PostgreSQL DAL,
 * running migrations, and registering all models exactly once during application startup.
 * 
 * Phase 3 of the DAL modernization roadmap - eliminates double-initialization issues
 * and provides clean separation between production and test environments.
 */

const config = require('config');
const debug = require('../util/debug');
const PostgresDAL = require('../dal');

const DEFAULT_MODEL_INITIALIZERS = [
    { key: 'users', initializer: require('../models/user').initializeModel },
    { key: 'user_metas', initializer: require('../models/user-meta').initializeModel },
    { key: 'teams', initializer: require('../models/team').initializeModel },
    { key: 'team_join_requests', initializer: require('../models/team-join-request').initializeModel },
    { key: 'team_slugs', initializer: require('../models/team-slug').initializeModel },
    { key: 'things', initializer: require('../models/thing').initializeModel },
    { key: 'thing_slugs', initializer: require('../models/thing-slug').initializeModel },
    { key: 'reviews', initializer: require('../models/review').initializeModel },
    { key: 'blog_posts', initializer: require('../models/blog-post').initializeModel },
    { key: 'files', initializer: require('../models/file').initializeModel },
    { key: 'invite_links', initializer: require('../models/invite-link').initializeModel }
];

// Global DAL state
let globalDAL = null;
let initializationPromise = null;

/**
 * Initialize the DAL and register all models
 * @param {Object} [customConfig] - Optional custom configuration for testing
 * @returns {Promise<DataAccessLayer>} The initialized DAL instance
 */
async function initializeDAL(customConfig = null) {
    // Return existing initialization if in progress or complete
    if (initializationPromise) {
        return initializationPromise;
    }

    initializationPromise = (async () => {
        let createdInternally = false;

        try {
            debug.db('Starting centralized DAL initialization...');

            if (customConfig) {
                globalDAL = PostgresDAL(customConfig);
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
                    const { getPostgresDAL } = require('../db-postgres');
                    globalDAL = await getPostgresDAL();
                    debug.db('Reusing existing PostgreSQL DAL instance');
                } catch (reuseError) {
                    debug.db('Unable to reuse shared DAL instance, creating a new one:', reuseError.message);
                    const dalConfig = config.postgres;
                    globalDAL = PostgresDAL(dalConfig);
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

            // Register all models
            await registerAllModels(globalDAL);

            debug.db('DAL bootstrap completed successfully');
            return globalDAL;

        } catch (error) {
            debug.error('DAL initialization failed:', error);
            // Reset state on failure
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
 * Register all application models with the DAL
 * @param {DataAccessLayer} dal - The DAL instance to register models with
 */
async function registerAllModels(dal, initializers = DEFAULT_MODEL_INITIALIZERS) {
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

/**
 * Get the global DAL instance (must be called after initialization)
 * @returns {DataAccessLayer} The global DAL instance
 * @throws {Error} If DAL hasn't been initialized yet
 */
function getDAL() {
    if (!globalDAL) {
        throw new Error('DAL not initialized. Call initializeDAL() first.');
    }
    return globalDAL;
}

/**
 * Get a registered model by table name
 * @param {string} tableName - The table name of the model
 * @returns {Model|null} The model instance or null if not found
 */
function getModel(tableName) {
    if (!globalDAL) {
        throw new Error('DAL not initialized. Call initializeDAL() first.');
    }

    try {
        return globalDAL.getModel(tableName);
    } catch (error) {
        const notFound = /Model '.*' not found/.test(error?.message || '');
        if (notFound) {
            return null;
        }
        throw error;
    }
}

/**
 * Get all registered models
 * @returns {Map} Map of table names to model instances
 */
function getAllModels() {
    if (!globalDAL) {
        return new Map();
    }
    return globalDAL.getRegisteredModels();
}

/**
 * Check if DAL is initialized
 * @returns {boolean} True if DAL is ready for use
 */
function isInitialized() {
    return globalDAL !== null;
}

/**
 * Gracefully shutdown the DAL
 */
async function shutdown() {
    if (globalDAL) {
        try {
            const postgresModule = require('../db-postgres');
            const sharedDAL = postgresModule?.dal;

            if (sharedDAL && sharedDAL === globalDAL) {
                await postgresModule.closeConnection();
            } else {
                await globalDAL.disconnect();
            }

            debug.db('DAL connection closed');
        } catch (error) {
            debug.error('Error closing DAL connection:', error);
        }

        // Reset state
        globalDAL = null;
        initializationPromise = null;
    }
}

/**
 * Create an isolated DAL harness for tests.
 * @param {Object} options - Harness configuration.
 * @param {Object} [options.configOverride] - Overrides merged into the postgres config.
 * @param {string} [options.schemaName] - Optional schema name to create and scope the harness to.
 * @param {string} [options.tablePrefix] - Optional table prefix (defaults to `${schemaName}.`).
 * @param {boolean} [options.autoMigrate=true] - Whether to run migrations automatically.
 * @param {boolean} [options.registerModels=true] - Whether to register default models.
 * @param {Array} [options.modelInitializers] - Custom model initializers to run.
 * @returns {Promise<{dal: DataAccessLayer, registeredModels: Map, schemaName: string|null, tablePrefix: string|null, cleanup: Function}>}
 */
async function createTestHarness(options = {}) {
    const {
        configOverride = {},
        schemaName = null,
        tablePrefix = null,
        autoMigrate = true,
        registerModels: shouldRegisterModels = true,
        modelInitializers = DEFAULT_MODEL_INITIALIZERS
    } = options;

    if (!config.has('postgres')) {
        throw new Error('PostgreSQL configuration not found. Cannot create test harness.');
    }

    const baseConfig = config.get('postgres');
    const dalConfig = {
        ...baseConfig,
        allowExitOnIdle: true,
        ...configOverride
    };

    debug.db('Creating isolated test DAL harness...');
    const testDAL = PostgresDAL(dalConfig);
    await testDAL.connect();

    let activeSchema = schemaName || null;
    let activePrefix = tablePrefix || null;

    if (activeSchema) {
        await testDAL.query(`CREATE SCHEMA IF NOT EXISTS ${activeSchema}`);
        await testDAL.query(`SET search_path TO ${activeSchema}, public`);

        if (testDAL.pool?.on) {
            testDAL.pool.on('connect', client => {
                client.query(`SET search_path TO ${activeSchema}, public`).catch(() => {});
            });
        }

        activePrefix = activePrefix || `${activeSchema}.`;
    }

    if (activePrefix) {
        testDAL.tablePrefix = activePrefix;
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
                await testDAL.query(`DROP SCHEMA IF EXISTS ${activeSchema} CASCADE`);
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
        tablePrefix: activePrefix,
        registeredModels: registered,
        cleanup
    };
}

module.exports = {
    initializeDAL,
    getDAL,
    getModel,
    getAllModels,
    isInitialized,
    shutdown,
    registerAllModels,
    createTestHarness
};
