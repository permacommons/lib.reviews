import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance
} from './model-types.ts';

export interface GetOrCreateModelOptions extends JsonObject {
  registryKey?: string;
}

export interface GetOrCreateModelResult<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>
> {
  model: ModelConstructor<TRecord, TVirtual, TInstance>;
  isNew: boolean;
}

/**
 * Attempt to fetch a previously registered model constructor without throwing
 * when the DAL has not seen the requested key.
 * @param dal Active data access layer used for lookups.
 * @param key Registry key or table name to resolve.
 * @returns The registered constructor or null when missing.
 */
function safeGetModel<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>
>(
  dal: DataAccessLayer,
  key: string
): ModelConstructor<TRecord, TVirtual, TInstance> | null {
  if (!key) {
    return null;
  }

  try {
    const model = dal.getModel<TRecord, TVirtual>(key) as ModelConstructor<TRecord, TVirtual, TInstance> | null;
    return model ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/Model '.*' not found/.test(message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Fetch a registered model if one exists or create a new constructor by
 * delegating to the DAL. Useful for bootstrap flows that can run multiple
 * times in dev environments without duplicating registrations.
 * @param dal Connected data access layer that owns the model registry.
 * @param tableName Table name used as the base registration key.
 * @param schema JSON schema describing the model definition.
 * @param options Optional registry metadata such as an explicit registry key.
 * @returns Descriptor containing the resolved model and whether it was newly created.
 */
export function getOrCreateModel<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>
>(
  dal: DataAccessLayer,
  tableName: string,
  schema: JsonObject,
  options: GetOrCreateModelOptions = {}
): GetOrCreateModelResult<TRecord, TVirtual, TInstance> {
  const { registryKey, ...modelOptions } = options;
  const lookupKeys = new Set<string>();

  if (typeof registryKey === 'string' && registryKey.length > 0) {
    lookupKeys.add(registryKey);
  }

  if (typeof tableName === 'string' && tableName.length > 0) {
    lookupKeys.add(tableName);
  }

  for (const key of lookupKeys) {
    const existing = safeGetModel<TRecord, TVirtual, TInstance>(dal, key);
    if (existing) {
      return { model: existing, isNew: false };
    }
  }

  const model = dal.createModel<TRecord, TVirtual>(tableName, schema, {
    ...modelOptions,
    registryKey
  }) as ModelConstructor<TRecord, TVirtual, TInstance>;

  return { model, isNew: true };
}

const factory = { getOrCreateModel };

export { factory as default };
