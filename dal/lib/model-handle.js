'use strict';

/**
 * Model Handle Factory
 * 
 * Creates synchronous handles that proxy to registered models.
 * 
 * This uses JavaScript's Proxy API to automatically forward method calls
 * to the registered model instance, providing a clean, self-aware interface
 * that adapts to whatever methods the actual model exposes.
 * 
 */

/**
 * Create a synchronous handle for a model that proxies to the registered instance
 * @param {string} tableName - The table name used to register the model
 * @param {Object} [staticMethods] - Additional static methods to expose
 * @param {Object} [staticProperties] - Additional static properties to expose
 * @returns {Object} Synchronous handle that proxies to the registered model
 */
function createModelHandle(tableName, staticMethods = {}, staticProperties = {}) {
    const handle = {};

    // Helper to get the registered model
    function getRegisteredModel() {
        const { getModel } = require('../../bootstrap/dal');
        const model = getModel(tableName);
        if (!model) {
            throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
        }
        return model;
    }

    // Core DAL methods that all models have
    const coreMethods = [
        'filter', 'get', 'create', 'save', 'delete', 'run',
        // Revision methods (if present)
        'createFirstRevision', 'getNotStaleOrDeleted', 'filterNotStaleOrDeleted',
        'getMultipleNotStaleOrDeleted'
    ];

    // Add core method proxies
    coreMethods.forEach(methodName => {
        handle[methodName] = function (...args) {
            const model = getRegisteredModel();
            if (typeof model[methodName] === 'function') {
                return model[methodName](...args);
            }
            throw new Error(`Method ${methodName} not available on ${tableName} model`);
        };
    });

    // Add custom static methods
    Object.keys(staticMethods).forEach(methodName => {
        handle[methodName] = function (...args) {
            const model = getRegisteredModel();
            if (typeof model[methodName] === 'function') {
                return model[methodName](...args);
            }
            throw new Error(`Method ${methodName} not available on ${tableName} model`);
        };
    });

    // Add static properties with getters
    Object.keys(staticProperties).forEach(propName => {
        Object.defineProperty(handle, propName, {
            get() {
                const model = getRegisteredModel();
                return model[propName] !== undefined ? model[propName] : staticProperties[propName];
            },
            enumerable: true,
            configurable: false
        });
    });

    // Add a generic proxy for any method not explicitly defined
    return new Proxy(handle, {
        get(target, prop, receiver) {
            // If the property exists on our handle, use it
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }

            // Otherwise, try to proxy to the registered model
            try {
                const model = getRegisteredModel();
                const value = model[prop];

                if (typeof value === 'function') {
                    return function (...args) {
                        return value.apply(model, args);
                    };
                }

                return value;
            } catch (error) {
                // If model isn't registered yet, return undefined for property access
                // This allows for graceful degradation during startup
                return undefined;
            }
        },

        has(target, prop) {
            if (prop in target) {
                return true;
            }

            try {
                const model = getRegisteredModel();
                return prop in model;
            } catch (error) {
                return false;
            }
        }
    });
}

/**
 * Create a model handle with automatic method detection
 * This version inspects the model definition to automatically create proxies
 * @param {string} tableName - The table name used to register the model
 * @param {Function} initializeModel - The model initialization function
 * @param {Object} [options] - Additional options
 * @param {Object} options.staticProperties - Static properties to expose
 * @returns {Object} Synchronous handle with auto-detected methods
 */
function createAutoModelHandle(tableName, initializeModel, options = {}) {
    const {
        staticProperties = {},
        staticMethods = {}
    } = options;

    // Helper to get the registered model
    function getRegisteredModel() {
        const { getModel } = require('../../bootstrap/dal');
        const model = getModel(tableName);
        if (!model) {
            throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
        }
        return model;
    }

    // Create a function that can be used as a constructor
    function ModelHandle(...args) {
        // When called as constructor, delegate to the registered model
        const model = getRegisteredModel();
        return new model(...args);
    }

    // Add static properties with getters
    Object.keys(staticProperties).forEach(propName => {
        Object.defineProperty(ModelHandle, propName, {
            get() {
                try {
                    const model = getRegisteredModel();
                    return model[propName] !== undefined ? model[propName] : staticProperties[propName];
                } catch (error) {
                    return staticProperties[propName];
                }
            },
            enumerable: true,
            configurable: false
        });
    });

    // Create a proxy that forwards everything to the registered model
    return new Proxy(ModelHandle, {
        get(target, prop, receiver) {
            if (prop in staticMethods) {
                return function (...args) {
                    const model = getRegisteredModel();
                    const method = typeof model[prop] === 'function' ? model[prop] : staticMethods[prop];
                    if (typeof method !== 'function') {
                        throw new Error(`Method ${prop} not available on ${tableName} model`);
                    }
                    return method.apply(model, args);
                };
            }

            // If the property exists on our handle, use it
            if (prop in target) {
                return Reflect.get(target, prop, receiver);
            }

            // Special case for the initializeModel function
            if (prop === 'initializeModel') {
                return initializeModel;
            }

            // Otherwise, try to proxy to the registered model
            try {
                const model = getRegisteredModel();
                const value = model[prop];

                if (typeof value === 'function') {
                    return function (...args) {
                        return value.apply(model, args);
                    };
                }

                return value;
            } catch (error) {
                // If model isn't registered yet, return undefined for property access
                // This allows for graceful degradation during startup
                return undefined;
            }
        },

        has(target, prop) {
            if (prop in target) {
                return true;
            }

            if (prop === 'initializeModel') {
                return true;
            }

            try {
                const model = getRegisteredModel();
                return prop in model;
            } catch (error) {
                return false;
            }
        }
    });
}

module.exports = {
    createModelHandle,
    createAutoModelHandle
};
