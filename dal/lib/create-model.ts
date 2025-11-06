import type { InferConstructor, ModelManifest } from './model-manifest.ts';
import { getAllManifests, getManifest, registerManifest } from './model-registry.ts';
import { initializeModel } from './model-initializer.ts';
import type { DataAccessLayer } from './model-types.ts';

// Cache for initialized models (populated by bootstrap)
const initializedModels = new Map<string, unknown>();

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
  // Convert manifest to initializeModel options format
  const options: {
    dal: DataAccessLayer;
    baseTable: string;
    schema: Record<string, any>;
    camelToSnake?: Record<string, string>;
    staticMethods?: Record<string, any>;
    instanceMethods?: Record<string, any>;
    relations?: readonly any[];
    withRevision?: {
      static?: ('createFirstRevision' | 'getNotStaleOrDeleted' | 'filterNotStaleOrDeleted' | 'getMultipleNotStaleOrDeleted')[];
      instance?: ('deleteAllRevisions')[];
    };
  } = {
    dal,
    baseTable: manifest.tableName,
    schema: manifest.schema,
    camelToSnake: manifest.camelToSnake,
    staticMethods: manifest.staticMethods || {},
    instanceMethods: manifest.instanceMethods || {},
    relations: manifest.relations || [],
    withRevision: manifest.hasRevisions
      ? {
          static: [
            'createFirstRevision',
            'getNotStaleOrDeleted',
            'filterNotStaleOrDeleted',
            'getMultipleNotStaleOrDeleted',
          ],
          instance: ['deleteAllRevisions'],
        }
      : undefined,
  };

  const { model } = initializeModel(options as any);
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
  manifest: Manifest
): InferConstructor<Manifest> {
  // Register the manifest in the global registry
  registerManifest(manifest);

  // Create a function target so the proxy can be used as a constructor
  const target = function () {} as unknown as InferConstructor<Manifest>;

  // Return a proxy that forwards to the initialized model
  // Model will be initialized by bootstrap before any app code runs
  return new Proxy(target, {
    get(_target, prop: string | symbol) {
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
