import { createFilterWhereStatics } from './filter-where.ts';
import type { InitializeModelOptions } from './model-initializer.ts';
import { initializeModel } from './model-initializer.ts';
import type {
  InferConstructor,
  InferData,
  InferInstance,
  InferVirtual,
  ModelManifest,
} from './model-manifest.ts';
import { getAllManifests, registerManifest } from './model-registry.ts';
import type { DataAccessLayer, InstanceMethod, JsonObject } from './model-types.ts';

// Cache for initialized models (populated by bootstrap)
const initializedModels = new Map<string, unknown>();
const filterWhereStaticsByTable = new Map<string, ReturnType<typeof createFilterWhereStatics>>();

interface CreateModelOptions {
  staticProperties?: Record<string, unknown>;
}

type EmptyRecord = Record<never, never>;

type ModelConstructorWithStatics<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
> = InferConstructor<Manifest> & ExtraStatics;

export interface DefineModelOptions<ExtraStatics extends Record<string, unknown>> {
  statics?: ExtraStatics;
}

/**
 * Initialize a model from its manifest
 * Called by bootstrap after DAL is ready
 *
 * @param manifest - Model manifest definition
 * @param dal - DAL instance to use
 * @returns Initialized model constructor
 */
function initializeFromManifest<Manifest extends ModelManifest>(
  manifest: Manifest,
  dal: DataAccessLayer
): InferConstructor<Manifest> {
  type Data = InferData<Manifest['schema']>;
  type Virtual = InferVirtual<Manifest['schema']>;
  type Instance = InferInstance<Manifest>;

  const relationDefinitions = manifest.relations
    ? manifest.relations.map(relation => ({ ...relation }))
    : null;

  // Convert manifest to initializeModel options format
  const options: InitializeModelOptions<Data, Virtual, Instance> = {
    dal,
    baseTable: manifest.tableName,
    schema: manifest.schema,
    withRevision: manifest.hasRevisions
      ? {
          static: ['createFirstRevision', 'getNotStaleOrDeleted', 'getMultipleNotStaleOrDeleted'],
          instance: ['deleteAllRevisions'],
        }
      : false,
    relations: relationDefinitions,
  };

  if (manifest.camelToSnake) {
    options.camelToSnake = manifest.camelToSnake;
  }

  if (manifest.staticMethods) {
    options.staticMethods = manifest.staticMethods as InitializeModelOptions<
      Data,
      Virtual,
      Instance
    >['staticMethods'];
  }

  if (manifest.instanceMethods) {
    options.instanceMethods = manifest.instanceMethods as Record<string, InstanceMethod<Instance>>;
  }

  const { model } = initializeModel<Data, Virtual, Instance>(options);

  const filterStatics = filterWhereStaticsByTable.get(manifest.tableName);
  if (filterStatics) {
    Object.assign(model as Record<string, unknown>, filterStatics);
  }

  if (!Object.prototype.hasOwnProperty.call(model, 'createFromRow')) {
    Object.defineProperty(model, 'createFromRow', {
      value(row: JsonObject) {
        const runtime = model as InferConstructor<Manifest> & {
          _createInstance?: (data: JsonObject) => InferInstance<Manifest>;
        };

        if (typeof runtime._createInstance !== 'function') {
          throw new Error(
            `Model "${manifest.tableName}" does not expose _createInstance; bootstrap may be incomplete.`
          );
        }

        return runtime._createInstance(row);
      },
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return model as InferConstructor<Manifest>;
}

/**
 * Create a typed model handle from a manifest
 *
 * This is the main entry point for manifest-based models.
 * Returns a lazy proxy that initializes the model on first access.
 *
 * @param manifest - Model manifest definition
 * @returns Typed model constructor
 *
 * @example
 * ```typescript
 * const userManifest = {
 *   tableName: 'users',
 *   hasRevisions: true,
 *   schema: { id: types.string().uuid(4), ... },
 * } as const;
 *
 * const User = createModel(userManifest);
 * export default User;
 *
 * // Usage (fully typed):
 * const user = await User.get('123');
 * user.displayName; // Type: string
 * ```
 */
export function createModel<Manifest extends ModelManifest>(
  manifest: Manifest,
  options: CreateModelOptions = {}
): InferConstructor<Manifest> {
  // Register the manifest in the global registry
  registerManifest(manifest);

  const filterWhereStatics = createFilterWhereStatics(manifest);
  filterWhereStaticsByTable.set(manifest.tableName, filterWhereStatics);

  const providedStatic = options.staticProperties ?? {};

  const getRuntime = () => {
    const runtime = initializedModels.get(manifest.tableName) as
      | (InferConstructor<Manifest> & {
          _createInstance?: (row: JsonObject) => InferInstance<Manifest>;
        })
      | undefined;

    if (!runtime || typeof runtime._createInstance !== 'function') {
      throw new Error(
        `Model "${manifest.tableName}" has not been initialized yet. ` +
          'Ensure bootstrap has completed before accessing models.'
      );
    }

    return runtime;
  };

  const createFromRow = (row: JsonObject): InferInstance<Manifest> => {
    const runtime = getRuntime();
    return runtime._createInstance(row);
  };

  const staticProperties = { ...filterWhereStatics, ...providedStatic, createFromRow };
  const staticPropertyKeys = new Set(Object.keys(staticProperties));

  // Create a function target so the proxy can be used as a constructor
  function TargetConstructor(this: unknown) {
    // Intentionally empty: runtime constructor is provided by initialized model.
  }

  const target = TargetConstructor as unknown as InferConstructor<Manifest>;

  for (const [prop, value] of Object.entries(staticProperties)) {
    Object.defineProperty(target, prop, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }

  // Return a proxy that forwards to the initialized model
  // Model will be initialized by bootstrap before any app code runs
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
      if (staticPropertyKeys.has(String(prop))) {
        return Reflect.get(target, prop);
      }

      const model = initializedModels.get(manifest.tableName) as
        | InferConstructor<Manifest>
        | undefined;

      if (!model) {
        throw new Error(
          `Model "${manifest.tableName}" has not been initialized yet. ` +
            'Ensure bootstrap has completed before accessing models.'
        );
      }

      // Access the property on the model
      const value = (model as unknown as Record<string | symbol, unknown>)[prop];

      // Bind methods to the model instance
      if (typeof value === 'function') {
        return value.bind(model);
      }

      return value;
    },

    // Support for 'new' operator
    construct(_target, args): object {
      const model = initializedModels.get(manifest.tableName) as
        | InferConstructor<Manifest>
        | undefined;

      if (!model) {
        throw new Error(
          `Model "${manifest.tableName}" has not been initialized yet. ` +
            'Ensure bootstrap has completed before accessing models.'
        );
      }

      return new (model as new (...args: unknown[]) => unknown)(...args) as object;
    },
  });
}

/**
 * Initialize all registered manifest-based models
 * Called by bootstrap after DAL is connected
 *
 * @param dal - Connected DAL instance
 */
export function initializeManifestModels(dal: DataAccessLayer): void {
  const manifests = getAllManifests();

  for (const [tableName, manifest] of manifests) {
    if (!initializedModels.has(tableName)) {
      const model = initializeFromManifest(manifest, dal);
      initializedModels.set(tableName, model);
    }
  }
}

/**
 * Clear the initialized model cache
 * Used primarily for testing to ensure clean state
 */
export function clearModelCache(): void {
  initializedModels.clear();
}

export function defineModelManifest<Manifest extends ModelManifest>(manifest: Manifest): Manifest {
  return manifest;
}

export function defineStaticMethods<
  Manifest extends ModelManifest,
  Methods extends Record<string, (...args: unknown[]) => unknown>,
>(manifest: Manifest, methods: Methods & ThisType<InferConstructor<Manifest> & Methods>): Methods {
  return methods;
}

export function defineInstanceMethods<
  Manifest extends ModelManifest,
  Methods extends Record<string, InstanceMethod>,
>(manifest: Manifest, methods: Methods & ThisType<InferInstance<Manifest> & Methods>): Methods {
  return methods;
}

/**
 * Convenience wrapper around {@link createModel} that preserves manifest-derived
 * typing while layering on additional statics in a type-safe manner.
 *
 * This is purely a TypeScript ergonomic helper. At runtime it forwards directly
 * to {@link createModel}, ensuring the emitted JavaScript stays unchanged.
 *
 * @param manifest - Model manifest definition
 * @param options - Additional statics to merge onto the constructor
 * @returns Typed model constructor enriched with the provided statics
 */
export function defineModel<Manifest extends ModelManifest>(
  manifest: Manifest
): ModelConstructorWithStatics<Manifest>;
export function defineModel<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
>(
  manifest: Manifest,
  options?: DefineModelOptions<ExtraStatics>
): ModelConstructorWithStatics<Manifest, ExtraStatics>;
export function defineModel<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
>(
  manifest: Manifest,
  options?: DefineModelOptions<ExtraStatics>
): ModelConstructorWithStatics<Manifest, ExtraStatics> {
  const extraStatics = options?.statics;

  const model = createModel(manifest, {
    staticProperties: extraStatics,
  });

  return model as ModelConstructorWithStatics<Manifest, ExtraStatics>;
}
