import { createFilterWhereStatics } from './filter-where.ts';
import { getRegisteredModel } from './model-handle.ts';
import type { InitializeModelOptions, StaticMethod } from './model-initializer.ts';
import { initializeModel } from './model-initializer.ts';
import type {
  InferConstructor,
  InferData,
  InferInstance,
  InferVirtual,
  ManifestVirtualFields,
  ModelManifest,
} from './model-manifest.ts';
import { getAllManifests, registerManifest } from './model-registry.ts';
import type { DataAccessLayer, InstanceMethod, JsonObject } from './model-types.ts';

const filterWhereStaticsByTable = new Map<string, ReturnType<typeof createFilterWhereStatics>>();

interface CreateModelOptions {
  staticProperties?: Record<string, unknown>;
}

type EmptyRecord = Record<never, never>;
type EmptyStaticMethods = Record<never, StaticMethod>;
type EmptyInstanceMethods = Record<never, InstanceMethod>;

type ModelConstructorWithStatics<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
> = InferConstructor<Manifest> & ExtraStatics;

/**
 * Merge separately-provided methods into a manifest type.
 * Uses intersection to preserve the original manifest's relations type.
 */
type MergeManifestMethods<
  Manifest extends ModelManifest,
  StaticMethods extends Record<string, StaticMethod>,
  InstanceMethods extends object,
> = Manifest &
  (keyof StaticMethods extends never ? unknown : { staticMethods: StaticMethods }) &
  (keyof InstanceMethods extends never ? unknown : { instanceMethods: InstanceMethods });

export interface DefineModelOptions<
  ExtraStatics extends Record<string, unknown>,
  StaticMethods extends Record<string, StaticMethod>,
  InstanceMethods extends object,
> {
  statics?: ExtraStatics;
  staticMethods?: StaticMethods;
  instanceMethods?: InstanceMethods;
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
  type Virtual = ManifestVirtualFields<Manifest>;
  type Instance = InferInstance<Manifest>;

  // Extract relation definitions, resolving target functions to targetTable strings
  const relationDefinitions = manifest.relations
    ? manifest.relations.map(relation => {
        const { target, ...rest } = relation;

        // If target is a function, call it to get the model reference and extract tableName
        if (typeof target === 'function') {
          try {
            const targetModel = target() as { tableName?: string } | null | undefined;
            if (targetModel && typeof targetModel.tableName === 'string') {
              // Use resolved tableName, but don't override explicit targetTable
              return {
                ...rest,
                targetTable: rest.targetTable ?? targetModel.tableName,
              };
            }
          } catch {
            // Target resolution failed - model may not be registered yet
            // Fall back to explicit targetTable if provided
          }
        }

        return rest;
      })
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
    views: manifest.views || undefined,
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
 * Create a lazy proxy for a model manifest. This is the internal implementation
 * used by defineModel(). The proxy forwards all property access to the initialized
 * model from the DAL registry.
 *
 * @param manifest - Model manifest definition
 * @param options - Optional static properties to attach
 * @returns Typed model proxy constructor
 *
 * @internal Most code should use defineModel() instead
 */
export function createModelProxy<Manifest extends ModelManifest>(
  manifest: Manifest,
  options: CreateModelOptions = {}
): InferConstructor<Manifest> {
  // Register the manifest in the global registry
  registerManifest(manifest);

  const filterWhereStatics = createFilterWhereStatics(manifest);
  filterWhereStaticsByTable.set(manifest.tableName, filterWhereStatics);

  const providedStatic = options.staticProperties ?? {};

  type Data = InferData<Manifest['schema']>;
  type Virtual = ManifestVirtualFields<Manifest>;

  const getModel = () => {
    return getRegisteredModel<Data, Virtual>(manifest.tableName) as InferConstructor<Manifest> & {
      _createInstance?: (row: JsonObject) => InferInstance<Manifest>;
    };
  };

  const createFromRow = (row: JsonObject): InferInstance<Manifest> => {
    const model = getModel();
    if (typeof model._createInstance !== 'function') {
      throw new Error(
        `Model "${manifest.tableName}" does not expose _createInstance; bootstrap may be incomplete.`
      );
    }
    return model._createInstance(row);
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

      const model = getModel();

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
      const model = getModel();
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
    // Check if already initialized by checking DAL registry
    try {
      dal.getModel(tableName);
      // Already initialized, skip
      continue;
    } catch {
      // Not initialized yet, proceed
    }

    initializeFromManifest(manifest, dal);
  }
}

/**
 * Define static methods for a model with properly typed `this` context.
 *
 * @param manifest - Model manifest to derive types from
 * @param methods - Static methods with `this` bound to the model constructor
 * @returns The methods object with preserved typing
 */
export function defineStaticMethods<
  Manifest extends ModelManifest,
  Methods extends Record<string, StaticMethod>,
>(manifest: Manifest, methods: Methods & ThisType<InferConstructor<Manifest> & Methods>): Methods {
  return methods;
}

/**
 * Define instance methods for a model with properly typed `this` context.
 *
 * @param manifest - Model manifest to derive types from
 * @param methods - Instance methods with `this` bound to model instances
 * @returns The methods object with preserved typing
 */
export function defineInstanceMethods<
  Manifest extends ModelManifest,
  Methods extends Record<string, InstanceMethod>,
>(manifest: Manifest, methods: Methods & ThisType<InferInstance<Manifest> & Methods>): Methods {
  return methods;
}

/**
 * Convenience wrapper around {@link createModelProxy} that preserves manifest-derived
 * typing while layering on additional statics in a type-safe manner.
 *
 * This is purely a TypeScript ergonomic helper. At runtime it forwards directly
 * to {@link createModelProxy}, ensuring the emitted JavaScript stays unchanged.
 *
 * @param manifest - Model manifest definition
 * @returns Typed model constructor
 */
export function defineModel<Manifest extends ModelManifest>(
  manifest: Manifest
): ModelConstructorWithStatics<Manifest>;
export function defineModel<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
  StaticMethods extends Record<string, StaticMethod> = EmptyStaticMethods,
  InstanceMethods extends Record<string, InstanceMethod> = EmptyInstanceMethods,
>(
  manifest: Manifest,
  options?: DefineModelOptions<ExtraStatics, StaticMethods, InstanceMethods>
): ModelConstructorWithStatics<
  MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>,
  ExtraStatics
>;
export function defineModel<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
  StaticMethods extends Record<string, StaticMethod> = EmptyStaticMethods,
  InstanceMethods extends Record<string, InstanceMethod> = EmptyInstanceMethods,
>(
  manifest: Manifest,
  options?: DefineModelOptions<ExtraStatics, StaticMethods, InstanceMethods>
): ModelConstructorWithStatics<
  MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>,
  ExtraStatics
> {
  const extraStatics = options?.statics;

  const manifestWithMethods = {
    ...manifest,
    ...(options?.staticMethods ? { staticMethods: options.staticMethods } : {}),
    ...(options?.instanceMethods ? { instanceMethods: options.instanceMethods } : {}),
  } as MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>;

  const model = createModelProxy(manifestWithMethods, {
    staticProperties: extraStatics,
  });

  return model as ModelConstructorWithStatics<
    MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>,
    ExtraStatics
  >;
}

/**
 * Infer instance type from a manifest with additional instance methods.
 * Cleaner alternative to manually using MergeManifestMethods + InferInstance.
 *
 * @example
 * export type ReviewInstance = ManifestInstance<typeof reviewManifest, ReviewInstanceMethods>;
 */
export type ManifestInstance<
  Manifest extends ModelManifest,
  InstanceMethods extends object = Record<never, InstanceMethod>,
> = InferInstance<MergeManifestMethods<Manifest, Record<never, StaticMethod>, InstanceMethods>>;

/**
 * Infer model constructor type from a manifest with additional static and instance methods.
 * Cleaner alternative to manually using MergeManifestMethods + InferConstructor.
 *
 * @example
 * export type ReviewModel = ManifestModel<typeof reviewManifest, ReviewStaticMethods, ReviewInstanceMethods>;
 */
export type ManifestModel<
  Manifest extends ModelManifest,
  StaticMethods extends Record<string, StaticMethod> = Record<never, StaticMethod>,
  InstanceMethods extends object = Record<never, InstanceMethod>,
> = InferConstructor<MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>>;

export type { ModelConstructorWithStatics, MergeManifestMethods };
