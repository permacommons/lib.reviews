import { createFilterWhereStatics } from './filter-where.ts';
import { getRegisteredModel } from './model-handle.ts';
import type { InitializeModelOptions } from './model-initializer.ts';
import { initializeModel } from './model-initializer.ts';
import type {
  EmptyStaticMethods,
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
type EmptyInstanceMethods = Record<never, InstanceMethod>;
type MethodRecord = Record<string, (...args: any[]) => any>;

type ModelConstructorWithStatics<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
> = InferConstructor<Manifest> & ExtraStatics;

/**
 * Merge additional static/instance methods into a manifest type.
 *
 * This is used when you define methods separately from the manifest
 * (e.g., in models/*.ts files) and need to combine them.
 *
 * The conditional checks handle the case where no methods are provided
 * (empty objects) by using `unknown` to avoid adding empty properties.
 *
 * Uses intersection to preserve the original manifest's relations type.
 */
type MergeManifestMethods<
  Manifest extends ModelManifest,
  StaticMethods extends object,
  InstanceMethods extends object,
> = Manifest &
  (keyof StaticMethods extends never ? unknown : { staticMethods: StaticMethods }) &
  (keyof InstanceMethods extends never ? unknown : { instanceMethods: InstanceMethods });

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
 * Helper to define static methods with properly typed `this` context.
 *
 * This is a zero-cost abstraction - at runtime it just returns the methods object.
 * At compile-time, it provides TypeScript with ThisType<InferConstructor<Manifest> & Methods>
 * so that `this` inside your methods is correctly typed as the model constructor.
 *
 * @param manifest - Model manifest to derive types from
 * @param methods - Static methods with `this` bound to the model constructor
 * @returns The methods object with preserved typing
 *
 * @example
 * const reviewStaticMethods = defineStaticMethods(reviewManifest, {
 *   async create(this: ReviewModel, data: ReviewInputObject) {
 *     // `this` is fully typed as ReviewModel
 *     const thing = await this.findOrCreateThing(data);
 *     return this.createFirstRevision(...);
 *   }
 * });
 */
export function defineStaticMethods<Manifest extends ModelManifest, Methods extends object>(
  manifest: Manifest,
  methods: Methods & ThisType<InferConstructor<Manifest> & Methods>
): Methods {
  return methods;
}

/**
 * Helper to define instance methods with properly typed `this` context.
 *
 * This is a zero-cost abstraction - at runtime it just returns the methods object.
 * At compile-time, it provides TypeScript with ThisType<InferInstance<Manifest> & Methods>
 * so that `this` inside your methods is correctly typed as the model instance.
 *
 * @param manifest - Model manifest to derive types from
 * @param methods - Instance methods with `this` bound to model instances
 * @returns The methods object with preserved typing
 *
 * @example
 * const reviewInstanceMethods = defineInstanceMethods(reviewManifest, {
 *   populateUserInfo(this: ReviewInstance, user: UserAccessContext) {
 *     // `this` is fully typed as ReviewInstance
 *     if (user.id === this.createdBy) {
 *       this.userIsAuthor = true;
 *     }
 *   }
 * });
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
  StaticMethods extends object = EmptyStaticMethods,
  InstanceMethods extends Record<string, InstanceMethod> = EmptyInstanceMethods,
>(
  manifest: Manifest,
  options?: {
    statics?: ExtraStatics;
    staticMethods?: StaticMethods;
    instanceMethods?: InstanceMethods;
  }
): ModelConstructorWithStatics<
  MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>,
  ExtraStatics
>;
export function defineModel<
  Manifest extends ModelManifest,
  ExtraStatics extends Record<string, unknown> = EmptyRecord,
  StaticMethods extends object = EmptyStaticMethods,
  InstanceMethods extends Record<string, InstanceMethod> = EmptyInstanceMethods,
>(
  manifest: Manifest,
  options?: {
    statics?: ExtraStatics;
    staticMethods?: StaticMethods;
    instanceMethods?: InstanceMethods;
  }
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
 * Convenience helper to infer instance type from a manifest with additional instance methods.
 *
 * This is much cleaner than manually calling InferInstance<MergeManifestMethods<...>>.
 * Use this in your manifest file to define the instance type.
 *
 * @template Manifest - The model manifest
 * @template InstanceMethods - Additional instance methods (optional, defaults to no methods)
 *
 * @example
 * // In models/manifests/review.ts
 * export type ReviewInstance = ManifestInstance<typeof reviewManifest, ReviewInstanceMethods>;
 */
export type ManifestInstance<
  Manifest extends ModelManifest,
  InstanceMethods extends object = Record<never, InstanceMethod>,
> = InferInstance<MergeManifestMethods<Manifest, EmptyStaticMethods, InstanceMethods>>;

/**
 * Convenience helper to infer model constructor type from a manifest with additional methods.
 *
 * This is much cleaner than manually calling InferConstructor<MergeManifestMethods<...>>.
 * Use this in your manifest file to define the model constructor type.
 *
 * @template Manifest - The model manifest
 * @template StaticMethods - Additional static methods (optional, defaults to no methods)
 * @template InstanceMethods - Additional instance methods (optional, defaults to no methods)
 *
 * @example
 * // In models/manifests/review.ts
 * export type ReviewModel = ManifestModel<
 *   typeof reviewManifest,
 *   ReviewStaticMethods,
 *   ReviewInstanceMethods
 * >;
 */
export type ManifestModel<
  Manifest extends ModelManifest,
  StaticMethods extends object = EmptyStaticMethods,
  InstanceMethods extends object = Record<never, InstanceMethod>,
> = InferConstructor<MergeManifestMethods<Manifest, StaticMethods, InstanceMethods>>;

/**
 * Bundle of commonly used manifest-derived types.
 *
 * This keeps manifest files terse by collecting the different inferred types
 * in one place, so authors don't have to declare separate aliases for the
 * base model, base instance, data shape, and virtual fields.
 */
export type ManifestTypes<
  Manifest extends ModelManifest,
  StaticMethods extends object = EmptyStaticMethods,
  InstanceMethods extends object = Record<never, InstanceMethod>,
  RelationFields extends object = Record<never, never>,
> = {
  /**
   * Instance type including any relation fields added via intersection.
   */
  Instance: ManifestInstance<Manifest, InstanceMethods> & RelationFields;
  /**
   * Model constructor type including additional static/instance methods.
   */
  Model: ManifestModel<Manifest, StaticMethods, InstanceMethods>;
  /**
   * Base model constructor type without custom statics/instance methods.
   */
  BaseModel: InferConstructor<Manifest>;
  /**
   * Base instance type without custom instance methods or relations.
   */
  BaseInstance: InferInstance<Manifest>;
  /**
   * Persisted data shape inferred from the schema.
   */
  Data: InferData<Manifest['schema']>;
  /**
   * Virtual fields inferred from the schema.
   */
  Virtual: ManifestVirtualFields<Manifest>;
};

/**
 * Map a methods object to include the correct `this` type for model statics.
 *
 * This lets manifest authors describe their method signatures without
 * manually repeating `this: ModelType` on every function. The returned type
 * still exposes the fully-typed `this` context to callers.
 */
export type StaticMethodsFrom<
  Manifest extends ModelManifest,
  Methods extends MethodRecord,
  InstanceMethods extends Record<string, InstanceMethod> = EmptyInstanceMethods,
  RelationFields extends object = Record<never, never>,
> = {
  [K in keyof Methods]: (
    this: ManifestTypes<Manifest, Methods, InstanceMethods, RelationFields>['Model'] & Methods,
    ...args: Parameters<Methods[K]>
  ) => ReturnType<Methods[K]>;
};

/**
 * Map a methods object to include the correct `this` type for model instances.
 *
 * Similar to {@link StaticMethodsFrom}, but targets instance methods so they
 * receive the fully-typed instance (including relation fields) as their
 * `this` context without extra boilerplate.
 */
export type InstanceMethodsFrom<
  Manifest extends ModelManifest,
  Methods extends Record<string, InstanceMethod>,
  RelationFields extends object = Record<never, never>,
> = {
  [K in keyof Methods]: (
    this: ManifestTypes<Manifest, EmptyStaticMethods, Methods, RelationFields>['Instance'] &
      Methods,
    ...args: Parameters<Methods[K]>
  ) => ReturnType<Methods[K]>;
};

export type { ModelConstructorWithStatics, MergeManifestMethods };
