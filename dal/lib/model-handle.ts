import type {
  JsonObject,
  ModelConstructor,
  ModelInstance
} from './model-types.js';

type BootstrapModule = {
  getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TRecord, TVirtual> | null;
};

type BootstrapResolver = () => BootstrapModule;

let bootstrapResolver: BootstrapResolver = () => {
  throw new Error(
    'DAL bootstrap resolver not configured. Import bootstrap/dal.js before using model handles.'
  );
};

/**
 * Register a callback that returns the bootstrap module exports. Consumers use
 * this indirection so models can lazy-load handles without creating cycles.
 * @param resolver Function that resolves the bootstrap API when invoked.
 */
export function setBootstrapResolver(resolver: BootstrapResolver): void {
  if (typeof resolver !== 'function') {
    throw new Error('setBootstrapResolver expects a function');
  }
  bootstrapResolver = resolver;
}

function getBootstrapModule(): BootstrapModule {
  const module = bootstrapResolver();
  if (!module) {
    throw new Error('bootstrap/dal resolver did not return a module');
  }
  return module;
}

type ModelHandle<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>
> = Partial<ModelConstructor<TRecord, TVirtual, TInstance>> & Record<string | symbol, unknown>;

const CORE_METHODS = [
  'filter',
  'get',
  'create',
  'save',
  'delete',
  'run',
  'createFirstRevision',
  'getNotStaleOrDeleted',
  'filterNotStaleOrDeleted',
  'getMultipleNotStaleOrDeleted'
] as const;

/**
 * Build a proxy object that forwards calls to the live model constructor while
 * providing optional static helpers. Useful for modules that want to expose a
 * stable API before the DAL is fully initialized.
 * @param tableName Table name or registry key for the target model.
 * @param staticMethods Optional method overrides that fall back to the live model.
 * @param staticProperties Optional properties exposed before the model is resolved.
 * @returns Proxy handle that mirrors the runtime model API.
 */
export function createModelHandle<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>
>(
  tableName: string,
  staticMethods: Record<string, (...args: unknown[]) => unknown> = {},
  staticProperties: Record<string, unknown> = {}
): ModelHandle<TRecord, TVirtual, TInstance> {
  const handle: Record<string | symbol, unknown> = {};

  function getRegisteredModel(): ModelConstructor<TRecord, TVirtual, TInstance> {
    const { getModel } = getBootstrapModule();
    const model = getModel<TRecord, TVirtual>(tableName);
    if (!model) {
      throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
    }
    return model as ModelConstructor<TRecord, TVirtual, TInstance>;
  }

  for (const methodName of CORE_METHODS) {
    handle[methodName] = (...args: unknown[]) => {
      const model = getRegisteredModel();
      const method = model[methodName as keyof typeof model];
      if (typeof method === 'function') {
        return method.apply(model, args);
      }
      throw new Error(`Method ${methodName} not available on ${tableName} model`);
    };
  }

  for (const [methodName, method] of Object.entries(staticMethods)) {
    handle[methodName] = (...args: unknown[]) => {
      const model = getRegisteredModel();
      const targetMethod = model[methodName as keyof typeof model];
      if (typeof targetMethod === 'function') {
        return targetMethod.apply(model, args);
      }
      if (typeof method === 'function') {
        return method.apply(model, args);
      }
      throw new Error(`Method ${methodName} not available on ${tableName} model`);
    };
  }

  for (const [propName, value] of Object.entries(staticProperties)) {
    Object.defineProperty(handle, propName, {
      get() {
        const model = getRegisteredModel();
        if (propName in model) {
          return model[propName as keyof typeof model];
        }
        return value;
      },
      enumerable: true,
      configurable: false
    });
  }

  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      try {
        const model = getRegisteredModel();
        const value = model[prop as keyof typeof model];
        if (typeof value === 'function') {
          return (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(model, args);
        }
        return value;
      } catch (error) {
        return undefined;
      }
    },
    has(target, prop) {
      if (Reflect.has(target, prop)) {
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
  }) as ModelHandle<TRecord, TVirtual, TInstance>;
}

interface AutoModelHandleOptions {
  staticProperties?: Record<string, unknown>;
  staticMethods?: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * Create a constructor-like handle that defers to the registered model at call
 * time. This allows modules to export a class while relying on bootstrap to
 * wire up the actual implementation.
 * @param tableName Table name or registry key for the model.
 * @param initializeModel Function used to register the model during bootstrap.
 * @param options Static metadata to expose alongside the handle.
 * @returns Proxy constructor that mirrors the runtime model.
 */
export function createAutoModelHandle<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>
>(
  tableName: string,
  initializeModel: (...args: unknown[]) => unknown,
  options: AutoModelHandleOptions = {}
): ModelConstructor<TRecord, TVirtual, TInstance> {
  const { staticProperties = {}, staticMethods = {} } = options;

  function getRegisteredModel(): ModelConstructor<TRecord, TVirtual, TInstance> {
    const { getModel } = getBootstrapModule();
    const model = getModel<TRecord, TVirtual>(tableName);
    if (!model) {
      throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
    }
    return model as ModelConstructor<TRecord, TVirtual, TInstance>;
  }

  const ModelHandle = function (...args: unknown[]) {
    const model = getRegisteredModel();
    // eslint-disable-next-line new-cap
    return new (model as new (...constructorArgs: unknown[]) => TInstance)(...args);
  } as unknown as ModelConstructor<TRecord, TVirtual, TInstance>;

  for (const [propName, value] of Object.entries(staticProperties)) {
    Object.defineProperty(ModelHandle, propName, {
      get() {
        try {
          const model = getRegisteredModel();
          if (propName in model) {
            return model[propName as keyof typeof model];
          }
          return value;
        } catch (error) {
          return value;
        }
      },
      enumerable: true,
      configurable: false
    });
  }

  return new Proxy(ModelHandle, {
    get(target, prop, receiver) {
      if (prop in staticMethods) {
        return (...args: unknown[]) => {
          const model = getRegisteredModel();
          const method = model[prop as keyof typeof model];
          if (typeof method === 'function') {
            return method.apply(model, args);
          }
          const fallback = staticMethods[prop as keyof typeof staticMethods];
          if (typeof fallback === 'function') {
            return fallback.apply(model, args);
          }
          throw new Error(`Method ${String(prop)} not available on ${tableName} model`);
        };
      }

      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      if (prop === 'initializeModel') {
        return initializeModel;
      }

      try {
        const model = getRegisteredModel();
        const value = model[prop as keyof typeof model];
        if (typeof value === 'function') {
          return (...args: unknown[]) => (value as (...args: unknown[]) => unknown).apply(model, args);
        }
        return value;
      } catch (error) {
        return undefined;
      }
    },
    has(target, prop) {
      if (Reflect.has(target, prop)) {
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

interface LazyHandleExport<THandle extends object> {
  proxy: THandle;
  assignHandle: (handle: THandle) => void;
}

/**
 * Create a placeholder export that becomes fully functional once a model handle
 * is assigned. Guards against accidental access before bootstrap completes.
 * @param label Identifier used in error messages when access happens too early.
 * @returns Proxy along with a function that installs the resolved handle.
 */
export function createLazyHandleExport<THandle extends object>(label: string): LazyHandleExport<THandle> {
  let resolvedHandle: THandle | null = null;

  function ensureResolved(): THandle {
    if (!resolvedHandle) {
      throw new Error(`${label} model handle accessed before initialization`);
    }
    return resolvedHandle;
  }

  const target = function lazyModelHandle(this: unknown, ...args: unknown[]) {
    const handle = ensureResolved();
    if (typeof handle === 'function') {
      return (handle as unknown as (...invokeArgs: unknown[]) => unknown)(...args);
    }
    throw new Error(`${label} model handle is not callable`);
  } as unknown as THandle;

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

      const value = (resolvedHandle as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') {
        return value.bind(resolvedHandle);
      }
      return value;
    },
    set(currentTarget, prop, value, receiver) {
      if (!resolvedHandle || Reflect.has(currentTarget, prop)) {
        return Reflect.set(currentTarget, prop, value, receiver);
      }

      (resolvedHandle as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
    has(currentTarget, prop) {
      if (Reflect.has(currentTarget, prop)) {
        return true;
      }
      if (!resolvedHandle) {
        return false;
      }
      return prop in (resolvedHandle as object);
    },
    ownKeys(currentTarget) {
      if (!resolvedHandle) {
        return Reflect.ownKeys(currentTarget);
      }
      const keys = new Set([
        ...Reflect.ownKeys(currentTarget),
        ...Reflect.ownKeys(resolvedHandle as object)
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

      const descriptor = Object.getOwnPropertyDescriptor(resolvedHandle as object, prop);
      if (descriptor) {
        descriptor.configurable = true;
      }
      return descriptor;
    },
    apply(currentTarget, thisArg, args) {
      const handle = ensureResolved() as unknown as (...invokeArgs: unknown[]) => unknown;
      return Reflect.apply(handle, thisArg, args);
    },
    construct(currentTarget, args, newTarget) {
      const handle = ensureResolved() as unknown as new (...ctorArgs: unknown[]) => object;
      return Reflect.construct(handle, args, newTarget);
    }
  });

  function assignHandle(handle: THandle): void {
    resolvedHandle = handle;
  }

  return { proxy: proxy as THandle, assignHandle };
}

/**
 * Finalize a lazy handle export by wiring the resolved handle and copying any
 * additional exports onto the placeholder.
 * @param lazyExport Proxy created by {@link createLazyHandleExport}.
 * @param assignHandle Callback that installs the resolved handle.
 * @param resolvedHandle Live handle returned from bootstrap.
 * @param additionalProperties Optional descriptors to copy onto the proxy.
 * @returns The proxy after registration completes.
 */
export function registerLazyHandle<THandle extends object>(
  lazyExport: THandle,
  assignHandle: (handle: THandle) => void,
  resolvedHandle: THandle,
  additionalProperties: Record<string, PropertyDescriptor | unknown> = {}
): THandle {
  if (typeof assignHandle !== 'function') {
    throw new Error('registerLazyHandle requires a valid assignHandle function');
  }

  assignHandle(resolvedHandle);

  const descriptors: Record<string, PropertyDescriptor> = {};
  for (const [key, value] of Object.entries(additionalProperties)) {
    if (
      value && typeof value === 'object' && (
        Object.prototype.hasOwnProperty.call(value, 'get') ||
        Object.prototype.hasOwnProperty.call(value, 'set') ||
        Object.prototype.hasOwnProperty.call(value, 'value') ||
        Object.prototype.hasOwnProperty.call(value, 'writable')
      )
    ) {
      descriptors[key] = {
        enumerable: true,
        configurable: true,
        ...(value as PropertyDescriptor)
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

interface ModelModule<THandle extends object> {
  proxy: THandle;
  register: (options: {
    initializeModel: (...args: unknown[]) => unknown;
    handleOptions?: AutoModelHandleOptions;
    additionalExports?: Record<string, unknown>;
  }) => THandle;
}

/**
 * Convenience helper for modules that expose a model handle and initialization
 * function. Returns a proxy export plus a registrar that wires everything up
 * once bootstrap runs.
 * @param tableName Table name tied to the model registration.
 * @returns Module utilities for registering and accessing the model handle.
 */
export function createModelModule<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>
>({ tableName }: { tableName: string }): ModelModule<ModelConstructor<TRecord, TVirtual, TInstance>> {
  if (typeof tableName !== 'string' || tableName.length === 0) {
    throw new Error('createModelModule requires a tableName');
  }

  const { proxy, assignHandle } = createLazyHandleExport<ModelConstructor<TRecord, TVirtual, TInstance>>(tableName);
  let registered = false;

  function register({
    initializeModel,
    handleOptions = {},
    additionalExports = {}
  }: {
    initializeModel: (...args: unknown[]) => unknown;
    handleOptions?: AutoModelHandleOptions;
    additionalExports?: Record<string, unknown>;
  }): ModelConstructor<TRecord, TVirtual, TInstance> {
    if (registered) {
      return proxy;
    }

    if (typeof initializeModel !== 'function') {
      throw new Error(`createModelModule.register for ${tableName} requires initializeModel`);
    }

    const handle = createAutoModelHandle<TRecord, TVirtual, TInstance>(tableName, initializeModel, handleOptions);
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

export default modelHandleModule;
