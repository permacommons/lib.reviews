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

// Global DAL state
let globalDAL = null;
let initializationPromise = null;
let registeredModels = new Map();

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
            registeredModels.clear();
            throw error;
        }
    })();

    return initializationPromise;
}

/**
 * Register all application models with the DAL
 * @param {DataAccessLayer} dal - The DAL instance to register models with
 */
async function registerAllModels(dal) {
    debug.db('Registering all models...');

    registeredModels.clear();

    // Import all model initializers
    const modelInitializers = [
        require('../models-postgres/user').initializeModel,
        require('../models-postgres/user-meta').initializeModel,
        require('../models-postgres/team').initializeModel,
        require('../models-postgres/team-join-request').initializeModel,
        require('../models-postgres/team-slug').initializeModel,
        require('../models-postgres/thing').initializeModel,
        require('../models-postgres/thing-slug').initializeModel,
        require('../models-postgres/review').initializeModel,
        require('../models-postgres/blog-post').initializeModel,
        require('../models-postgres/file').initializeModel,
        require('../models-postgres/invite-link').initializeModel
    ];

    // Initialize each model and store the result
    for (const initializeModel of modelInitializers) {
        try {
            const model = await initializeModel(dal);
            if (model && model.tableName) {
                registeredModels.set(model.tableName, model);
                debug.db(`Registered model: ${model.tableName}`);
            }
        } catch (error) {
            debug.error(`Failed to register model:`, error);
            // Continue with other models - some may not be ready yet
        }
    }

    debug.db(`Successfully registered ${registeredModels.size} models`);
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
    return registeredModels.get(tableName) || null;
}

/**
 * Get all registered models
 * @returns {Map} Map of table names to model instances
 */
function getAllModels() {
    return new Map(registeredModels);
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
        registeredModels.clear();
    }
}

/**
 * Create a test DAL instance with isolated models
 * This is used by fixtures and tests to avoid interfering with the global DAL
 * @param {Object} testConfig - Test-specific configuration
 * @returns {Promise<Object>} Object containing DAL and initialized models
 */
async function createTestDAL(testConfig) {
    debug.db('Creating isolated test DAL...');

    const testDAL = PostgresDAL(testConfig);
    await testDAL.connect();

    // Initialize models for this test DAL
    const testModels = {};
    const modelInitializers = [
        { name: 'User', init: require('../models-postgres/user').initializeModel },
        { name: 'UserMeta', init: require('../models-postgres/user-meta').initializeModel },
        { name: 'Team', init: require('../models-postgres/team').initializeModel },
        { name: 'TeamJoinRequest', init: require('../models-postgres/team-join-request').initializeModel },
        { name: 'TeamSlug', init: require('../models-postgres/team-slug').initializeModel },
        { name: 'Thing', init: require('../models-postgres/thing').initializeModel },
        { name: 'ThingSlug', init: require('../models-postgres/thing-slug').initializeModel },
        { name: 'Review', init: require('../models-postgres/review').initializeModel },
        { name: 'BlogPost', init: require('../models-postgres/blog-post').initializeModel },
        { name: 'File', init: require('../models-postgres/file').initializeModel },
        { name: 'InviteLink', init: require('../models-postgres/invite-link').initializeModel }
    ];

    for (const { name, init } of modelInitializers) {
        try {
            testModels[name] = await init(testDAL);
        } catch (error) {
            debug.error(`Failed to initialize test model ${name}:`, error);
        }
    }

    return { dal: testDAL, models: testModels };
}

module.exports = {
    initializeDAL,
    getDAL,
    getModel,
    getAllModels,
    isInitialized,
    shutdown,
    createTestDAL
};
