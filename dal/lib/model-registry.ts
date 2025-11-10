import type { ModelManifest } from './model-manifest.ts';
import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance,
} from './model-types.ts';

export interface RegisterModelOptions extends JsonObject {
  key?: string;
}

type AnyModelConstructor = ModelConstructor<JsonObject, JsonObject, ModelInstance>;

/**
 * Track model constructors registered against a particular DAL instance. The
 * registry maintains lookups by both table name and optional registry key so
 * modules can share handles reliably.
 */
export class ModelRegistry {
  ownerDAL: DataAccessLayer;
  private modelsByTable: Map<string, AnyModelConstructor>;
  private modelsByKey: Map<string, AnyModelConstructor>;

  constructor(ownerDAL: DataAccessLayer) {
    this.ownerDAL = ownerDAL;
    this.modelsByTable = new Map();
    this.modelsByKey = new Map();
  }

  /**
   * Register a constructor for a table, optionally under a custom registry key.
   * @param tableName Name of the backing table.
   * @param model Constructor to store in the registry.
   * @param options Optional metadata that supplies a registry key.
   * @returns The registered constructor.
   */
  register<
    TRecord extends JsonObject,
    TVirtual extends JsonObject = JsonObject,
    TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
  >(
    tableName: string,
    model: ModelConstructor<TRecord, TVirtual, TInstance>,
    options: RegisterModelOptions = {}
  ): ModelConstructor<TRecord, TVirtual, TInstance> {
    if (typeof tableName !== 'string' || tableName.length === 0) {
      throw new Error('Model registry requires a valid tableName.');
    }

    if (typeof model !== 'function') {
      throw new Error('Model registry can only register constructor functions.');
    }

    const canonicalKey = options.key ?? tableName;
    const existingByTable = this.modelsByTable.get(tableName);
    if (existingByTable && existingByTable !== model) {
      throw new Error(`Model '${tableName}' already registered on this DAL instance.`);
    }

    const existingByKey = this.modelsByKey.get(canonicalKey);
    if (existingByKey && existingByKey !== model) {
      throw new Error(
        `Model registry key '${canonicalKey}' already registered on this DAL instance.`
      );
    }

    this.modelsByTable.set(tableName, model as AnyModelConstructor);
    this.modelsByKey.set(canonicalKey, model as AnyModelConstructor);

    return model;
  }

  /**
   * Retrieve a registered model by either table name or registry key.
   * @param identifier Table name or registry key to look up.
   * @returns The constructor when present, otherwise null.
   */
  get<
    TRecord extends JsonObject,
    TVirtual extends JsonObject = JsonObject,
    TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
  >(identifier: string): ModelConstructor<TRecord, TVirtual, TInstance> | null {
    if (!identifier) {
      return null;
    }

    const model = this.modelsByTable.get(identifier) ?? this.modelsByKey.get(identifier) ?? null;
    return model as ModelConstructor<TRecord, TVirtual, TInstance> | null;
  }

  /**
   * Determine whether the registry contains a model for the provided key.
   * @param identifier Table name or registry key to check.
   * @returns True when a constructor is registered.
   */
  has(identifier: string): boolean {
    return this.get(identifier) !== null;
  }

  /**
   * Snapshot the registry keyed by custom registry keys.
   * @returns Map of registry keys to constructors.
   */
  listByKey(): Map<string, AnyModelConstructor> {
    return new Map(this.modelsByKey);
  }

  /**
   * Snapshot the registry keyed by table name.
   * @returns Map of table names to constructors.
   */
  listByTable(): Map<string, AnyModelConstructor> {
    return new Map(this.modelsByTable);
  }

  /**
   * Remove all registered models from the registry, resetting internal state.
   */
  clear(): void {
    this.modelsByTable.clear();
    this.modelsByKey.clear();
  }
}

export default ModelRegistry;

// ----- Manifest Registry (for createModel() system) -----

/**
 * Global manifest registry for manifest-based models
 * Maps table names to their declarative manifests
 */
const manifestRegistry = new Map<string, ModelManifest>();

/**
 * Register a model manifest (called by createModel())
 *
 * @param manifest - Model manifest to register in the global registry
 */
export function registerManifest(manifest: ModelManifest): void {
  if (manifestRegistry.has(manifest.tableName)) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `Manifest for table "${manifest.tableName}" is being re-registered. ` +
          'This is normal in tests but may indicate a problem in production.'
      );
    }
  }
  manifestRegistry.set(manifest.tableName, manifest);
}

/**
 * Get a registered manifest by table name
 *
 * @param tableName - Database table name to look up
 * @returns The registered manifest, or undefined if not found
 */
export function getManifest(tableName: string): ModelManifest | undefined {
  return manifestRegistry.get(tableName);
}

/**
 * Get all registered manifests
 */
export function getAllManifests(): Map<string, ModelManifest> {
  return new Map(manifestRegistry);
}

/**
 * Clear manifest registry (primarily for testing)
 */
export function clearManifestRegistry(): void {
  manifestRegistry.clear();
}
