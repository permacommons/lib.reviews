import type {
  InferConstructor,
  InferData,
  InferInstance,
  InferVirtual,
  ModelManifest,
} from './model-manifest.ts';
import type { JsonObject, ModelConstructor, ModelInstance } from './model-types.ts';

type BootstrapModule = {
  getModel<TRecord extends JsonObject = JsonObject, TVirtual extends JsonObject = JsonObject>(
    name: string
  ): ModelConstructor<TRecord, TVirtual> | null;
};

type BootstrapResolver = () => BootstrapModule;

let bootstrapResolver: BootstrapResolver = () => {
  throw new Error(
    'DAL bootstrap resolver not configured. Import bootstrap/dal.ts before using model handles.'
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

/**
 * Look up a registered model by table name using the bootstrap resolver.
 * Used by both model handles and the createModel proxy system.
 * @param tableName Table name or registry key to look up.
 * @returns The registered model constructor.
 * @throws Error if model not found or bootstrap not initialized.
 */
export function getRegisteredModel<
  TRecord extends JsonObject = JsonObject,
  TVirtual extends JsonObject = JsonObject,
>(tableName: string): ModelConstructor<TRecord, TVirtual> {
  const { getModel } = getBootstrapModule();
  const model = getModel<TRecord, TVirtual>(tableName);
  if (!model) {
    throw new Error(`${tableName} model not registered. Ensure DAL is initialized.`);
  }
  return model as ModelConstructor<TRecord, TVirtual>;
}

type ModelHandle<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>,
> = Partial<ModelConstructor<TRecord, TVirtual, TInstance>> & Record<string | symbol, unknown>;

const CORE_METHODS = [
  'get',
  'create',
  'save',
  'delete',
  'run',
  'createFirstRevision',
  'getNotStaleOrDeleted',
  'getMultipleNotStaleOrDeleted',
] as const;

/**
 * Build a proxy object that forwards calls to the live model constructor while
 * providing optional static helpers. Used internally for creating cross-model
 * references without circular imports.
 * @param tableName Table name or registry key for the target model.
 * @param staticMethods Optional method overrides that fall back to the live model.
 * @param staticProperties Optional properties exposed before the model is resolved.
 * @returns Proxy reference that mirrors the runtime model API.
 */
export function createModelReference<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
>(
  tableName: string,
  staticMethods: Record<string, (...args: unknown[]) => unknown> = {},
  staticProperties: Record<string, unknown> = {}
): ModelHandle<TRecord, TVirtual, TInstance> {
  const handle: Record<string | symbol, unknown> = {};

  // Local helper to avoid repeating the type cast throughout this function
  function _getModel(): ModelConstructor<TRecord, TVirtual, TInstance> {
    return getRegisteredModel<TRecord, TVirtual>(tableName) as ModelConstructor<
      TRecord,
      TVirtual,
      TInstance
    >;
  }

  for (const methodName of CORE_METHODS) {
    handle[methodName] = (...args: unknown[]) => {
      const model = _getModel();
      const method = model[methodName as keyof typeof model];
      if (typeof method === 'function') {
        return method.apply(model, args);
      }
      throw new Error(`Method ${methodName} not available on ${tableName} model`);
    };
  }

  for (const [methodName, method] of Object.entries(staticMethods)) {
    handle[methodName] = (...args: unknown[]) => {
      const model = _getModel();
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
        const model = _getModel();
        if (propName in model) {
          return model[propName as keyof typeof model];
        }
        return value;
      },
      enumerable: true,
      configurable: false,
    });
  }

  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }

      try {
        const model = _getModel();
        const value = model[prop as keyof typeof model];
        if (typeof value === 'function') {
          return (...args: unknown[]) =>
            (value as (...args: unknown[]) => unknown).apply(model, args);
        }
        return value;
      } catch {
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
        const model = _getModel();
        return prop in model;
      } catch {
        return false;
      }
    },
  }) as ModelHandle<TRecord, TVirtual, TInstance>;
}

type StaticMethodsMap = Record<string, (...args: unknown[]) => unknown>;
type StaticPropertiesMap = Record<string, unknown>;

/**
 * Create a typed reference to another model using its manifest. This allows
 * models to reference each other without importing their full runtime code,
 * avoiding circular dependency issues.
 * @param manifest The model manifest to reference
 * @param staticMethods Optional static method overrides
 * @param staticProperties Optional static property overrides
 * @returns Typed model reference that resolves at runtime via bootstrap
 */
export function referenceModel<
  Manifest extends ModelManifest,
  Methods extends StaticMethodsMap = {},
  Properties extends StaticPropertiesMap = {},
>(
  manifest: Manifest,
  staticMethods?: Methods,
  staticProperties?: Properties
): InferConstructor<Manifest> & Methods & Properties {
  type Data = InferData<Manifest['schema']>;
  type Virtual = InferVirtual<Manifest['schema']>;
  type Instance = InferInstance<Manifest>;

  const resolvedMethods = (staticMethods ?? {}) as StaticMethodsMap;
  const resolvedProperties = (staticProperties ?? {}) as StaticPropertiesMap;

  const handle = createModelReference<Data, Virtual, Instance>(
    manifest.tableName,
    resolvedMethods,
    resolvedProperties
  );

  return handle as InferConstructor<Manifest> & Methods & Properties;
}

const modelHandleModule = {
  setBootstrapResolver,
  getRegisteredModel,
  createModelReference,
  referenceModel,
};

export default modelHandleModule;
