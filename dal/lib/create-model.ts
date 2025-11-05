import type { InferConstructor, ModelManifest } from './model-manifest.ts';
import { getManifest, registerManifest } from './model-registry.ts';
import { initializeModel } from './model-initializer.ts';
import type { DataAccessLayer } from './model-types.ts';

// Cache for initialized models (lazy initialization)
const initializedModels = new Map<string, unknown>();

/**
 * Get the active DAL instance
 * TODO: This currently relies on a global DAL - will need to be enhanced for test fixtures
 */
function getActiveDAL(): DataAccessLayer {
  // For now, import the singleton DAL
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dal = require('../index.ts').default;
  return dal;
}

/**
 * Initialize a model from its manifest
 * Delegates to existing initializeModel under the hood for now
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
  const options = {
    dal,
    baseTable: manifest.tableName,
    schema: manifest.schema,
    camelToSnake: manifest.camelToSnake,
    staticMethods: manifest.staticMethods || {},
    instanceMethods: manifest.instanceMethods || {},
    relations: manifest.relations || [],
    withRevision: manifest.hasRevisions
      ? {
          static: ['createFirstRevision', 'getNotStaleOrDeleted', 'filterNotStaleOrDeleted'] as const,
          instance: ['deleteAllRevisions'] as const,
        }
      : undefined,
  };

  const { model } = initializeModel(options);
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

  // Return a lazy proxy that initializes on first access
  return new Proxy({} as InferConstructor<Manifest>, {
    get(_target, prop: string | symbol) {
      // Get or initialize the model
      let model = initializedModels.get(manifest.tableName) as
        | InferConstructor<Manifest>
        | undefined;

      if (!model) {
        const dal = getActiveDAL();
        model = initializeFromManifest(manifest, dal);
        initializedModels.set(manifest.tableName, model);
      }

      // Access the property on the model
      const value = (model as Record<string | symbol, unknown>)[prop];

      // Bind methods to the model instance
      if (typeof value === 'function') {
        return value.bind(model);
      }

      return value;
    },

    // Support for 'new' operator
    construct(_target, args) {
      let model = initializedModels.get(manifest.tableName) as
        | InferConstructor<Manifest>
        | undefined;

      if (!model) {
        const dal = getActiveDAL();
        model = initializeFromManifest(manifest, dal);
        initializedModels.set(manifest.tableName, model);
      }

      return new (model as new (...args: unknown[]) => unknown)(...args);
    },
  });
}

/**
 * Clear the initialized model cache
 * Used primarily for testing to ensure clean state
 */
export function clearModelCache(): void {
  initializedModels.clear();
}
