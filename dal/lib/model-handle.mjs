let bootstrapResolver = () => {
  throw new Error(
    'DAL bootstrap resolver not configured. Import bootstrap/dal.mjs before using model handles.'
  );
};

function setBootstrapResolver(resolver) {
  if (typeof resolver !== 'function') {
    throw new Error('setBootstrapResolver expects a function');
  }
  bootstrapResolver = resolver;
}

function getBootstrapModule() {
  const module = bootstrapResolver();
  if (!module) {
    throw new Error('bootstrap/dal resolver did not return a module');
  }
  return module;
}

/**
 * Create a synchronous handle for a model that proxies to the registered instance.
 *
 * The returned proxy exposes core DAL methods and any additional static methods or
 * properties you provide while deferring to the lazily-registered model at call time.
 *
 * @param {string} tableName - Table name used to register the model.
 * @param {Record<string, Function>} [staticMethods] - Additional static methods to expose.
 * @param {Record<string, *>} [staticProperties] - Additional static properties to expose.
 * @returns {Proxy} Synchronous handle that proxies to the registered model.
 */
function createModelHandle(tableName, staticMethods = {}, staticProperties = {}) {
  const handle = {};

  function getRegisteredModel() {
    const { getModel } = getBootstrapModule();
    const model = getModel(tableName);
    if (!model) {
      throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
    }
    return model;
  }

  const coreMethods = [
    'filter', 'get', 'create', 'save', 'delete', 'run',
    'createFirstRevision', 'getNotStaleOrDeleted', 'filterNotStaleOrDeleted',
    'getMultipleNotStaleOrDeleted'
  ];

  coreMethods.forEach(methodName => {
    handle[methodName] = function (...args) {
      const model = getRegisteredModel();
      if (typeof model[methodName] === 'function') {
        return model[methodName](...args);
      }
      throw new Error(`Method ${methodName} not available on ${tableName} model`);
    };
  });

  Object.keys(staticMethods).forEach(methodName => {
    handle[methodName] = function (...args) {
      const model = getRegisteredModel();
      if (typeof model[methodName] === 'function') {
        return model[methodName](...args);
      }
      throw new Error(`Method ${methodName} not available on ${tableName} model`);
    };
  });

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

  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

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
 * Create a model handle with automatic method detection based on the registered model.
 *
 * @param {string} tableName - Table name used to register the model.
 * @param {Function} initializeModel - Model initialization function used during bootstrap.
 * @param {Object} [options]
 * @param {Record<string, *>} [options.staticProperties] - Static properties to expose.
 * @param {Record<string, Function>} [options.staticMethods] - Static methods to expose.
 * @returns {Proxy|Function} Handle that mirrors the registered model implementation.
 */
function createAutoModelHandle(tableName, initializeModel, options = {}) {
  const {
    staticProperties = {},
    staticMethods = {}
  } = options;

  function getRegisteredModel() {
    const { getModel } = getBootstrapModule();
    const model = getModel(tableName);
    if (!model) {
      throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
    }
    return model;
  }

  function ModelHandle(...args) {
    const model = getRegisteredModel();
    return new model(...args);
  }

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

      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      if (prop === 'initializeModel') {
        return initializeModel;
      }

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

const modelHandleModule = {
  setBootstrapResolver,
  createModelHandle,
  createAutoModelHandle,
  createLazyHandleExport,
  registerLazyHandle,
  createModelModule
};

export {
  setBootstrapResolver,
  createModelHandle,
  createAutoModelHandle,
  createLazyHandleExport,
  registerLazyHandle,
  createModelModule
};

export default modelHandleModule;
