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

/**
 * Create a placeholder export that can safely participate in circular
 * dependencies while deferring to a resolved handle once available.
 *
 * @param {string} label - Identifier used for debugging messages.
 * @returns {{ proxy: Function, assignHandle: Function }}
 */
function createLazyHandleExport(label) {
    let resolvedHandle = null;

    function ensureResolved() {
        if (!resolvedHandle) {
            throw new Error(`${label} model handle accessed before initialization`);
        }
        return resolvedHandle;
    }

    const target = function lazyModelHandle(...args) {
        const handle = ensureResolved();
        if (typeof handle === 'function') {
            return handle(...args);
        }
        throw new Error(`${label} model handle is not callable`);
    };

    const proxy = new Proxy(target, {
        get(currentTarget, prop, receiver) {
            if (prop === '__isLazyHandle') {
                return true;
            }

            if (Reflect.has(currentTarget, prop)) {
                return Reflect.get(currentTarget, prop, receiver);
            }

            if (!resolvedHandle) {
                throw new Error(`${label} model handle accessed before initialization`);
            }

            const value = resolvedHandle[prop];
            if (typeof value === 'function') {
                return value.bind(resolvedHandle);
            }

            return value;
        },

        set(currentTarget, prop, value, receiver) {
            if (!resolvedHandle || Reflect.has(currentTarget, prop)) {
                return Reflect.set(currentTarget, prop, value, receiver);
            }

            resolvedHandle[prop] = value;
            return true;
        },

        has(currentTarget, prop) {
            if (Reflect.has(currentTarget, prop)) {
                return true;
            }
            if (!resolvedHandle) {
                return false;
            }
            return prop in resolvedHandle;
        },

        ownKeys(currentTarget) {
            if (!resolvedHandle) {
                return Reflect.ownKeys(currentTarget);
            }
            const keys = new Set([
                ...Reflect.ownKeys(currentTarget),
                ...Reflect.ownKeys(resolvedHandle)
            ]);
            return Array.from(keys);
        },

        getOwnPropertyDescriptor(currentTarget, prop) {
            if (Reflect.has(currentTarget, prop)) {
                return Reflect.getOwnPropertyDescriptor(currentTarget, prop);
            }

            if (!resolvedHandle) {
                return undefined;
            }

            const descriptor = Object.getOwnPropertyDescriptor(resolvedHandle, prop);
            if (descriptor) {
                descriptor.configurable = true;
            }
            return descriptor;
        },

        apply(currentTarget, thisArg, args) {
            const handle = ensureResolved();
            return Reflect.apply(handle, thisArg, args);
        },

        construct(currentTarget, args, newTarget) {
            const handle = ensureResolved();
            return Reflect.construct(handle, args, newTarget);
        }
    });

    function assignHandle(handle) {
        resolvedHandle = handle;
    }

    return {
        proxy,
        assignHandle
    };
}

/**
 * Attach the resolved handle to a lazy export and register additional
 * properties that should live on the public module export.
 *
 * @param {Object} lazyExport - Proxy returned by createLazyHandleExport.
 * @param {Function} assignHandle - Function returned by createLazyHandleExport.
 * @param {Object|Function} resolvedHandle - Handle returned by createAutoModelHandle.
 * @param {Object} [additionalProperties={}] - Map of property descriptors or values to assign.
 * @returns {Object} The hydrated export (for convenience).
 */
function registerLazyHandle(lazyExport, assignHandle, resolvedHandle, additionalProperties = {}) {
    if (typeof assignHandle !== 'function') {
        throw new Error('registerLazyHandle requires a valid assignHandle function');
    }

    assignHandle(resolvedHandle);

    const descriptors = {};
    for (const [key, value] of Object.entries(additionalProperties || {})) {
        if (value && typeof value === 'object' &&
            (Object.prototype.hasOwnProperty.call(value, 'get') ||
             Object.prototype.hasOwnProperty.call(value, 'set') ||
             Object.prototype.hasOwnProperty.call(value, 'value') ||
             Object.prototype.hasOwnProperty.call(value, 'writable'))) {
            descriptors[key] = {
                enumerable: true,
                configurable: true,
                ...value
            };
        } else {
            descriptors[key] = {
                value,
                enumerable: true,
                configurable: true
            };
        }
    }

    if (Object.keys(descriptors).length > 0) {
        Object.defineProperties(lazyExport, descriptors);
    }

    return lazyExport;
}

/**
 * Convenience helper for wiring a model module export using the standard
 * lazy handle pattern.
 *
 * @param {Object} options - Configuration options.
 * @param {string} options.tableName - Table name used to register the model.
 * @param {Function} options.initializeModel - Async initializer function.
 * @param {Object} [options.handleOptions] - Options passed to createAutoModelHandle.
 * @param {Object} [options.additionalExports] - Extra exports to attach to the module.
 * @returns {{proxy: Object, register: Function}} Module export proxy and register hook.
 */
function createModelModule({
    tableName
}) {
    if (typeof tableName !== 'string' || !tableName.length) {
        throw new Error('createModelModule requires a tableName');
    }

    const { proxy, assignHandle } = createLazyHandleExport(tableName);
    let registered = false;

    function register({
        initializeModel,
        handleOptions = {},
        additionalExports = {}
    }) {
        if (registered) {
            return proxy;
        }
        if (typeof initializeModel !== 'function') {
            throw new Error(`createModelModule.register for ${tableName} requires initializeModel`);
        }

        const handle = createAutoModelHandle(tableName, initializeModel, handleOptions);
        registerLazyHandle(proxy, assignHandle, handle, {
            initializeModel,
            ...additionalExports
        });
        registered = true;
        return proxy;
    }

    return {
        proxy,
        register
    };
}

module.exports = {
    createModelHandle,
    createAutoModelHandle,
    createLazyHandleExport,
    registerLazyHandle,
    createModelModule
};
