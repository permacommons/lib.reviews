import { getOrCreateModel } from './model-factory.ts';
import type {
  DataAccessLayer,
  JsonObject,
  ModelConstructor,
  ModelInstance,
} from './model-types.ts';
import type { ModelConstructorLike } from './revision.ts';
import revision from './revision.ts';

const DEFAULT_REVISION_STATIC = [
  'createFirstRevision',
  'getNotStaleOrDeleted',
  'filterNotStaleOrDeleted',
] as const;

const DEFAULT_REVISION_INSTANCE = ['deleteAllRevisions'] as const;

const REVISION_HANDLER_MAP = {
  createFirstRevision: revision.getFirstRevisionHandler,
  getNotStaleOrDeleted: revision.getNotStaleOrDeletedGetHandler,
  filterNotStaleOrDeleted: revision.getNotStaleOrDeletedFilterHandler,
  getMultipleNotStaleOrDeleted: revision.getMultipleNotStaleOrDeletedHandler,
  newRevision: revision.getNewRevisionHandler,
  deleteAllRevisions: revision.getDeleteAllRevisionsHandler,
} as const;

type RevisionHandlerName = keyof typeof REVISION_HANDLER_MAP;

export type RevisionHandlerConfig = {
  static?: RevisionHandlerName[] | RevisionHandlerName;
  instance?: RevisionHandlerName[] | RevisionHandlerName;
};

export interface RelationConfig extends JsonObject {
  type?: string;
  model?: unknown;
  join?: JsonObject;
  targetTable?: string;
  table?: string;
  target?: string;
  targetModelKey?: string;
  targetModel?: unknown;
  sourceColumn?: string;
  sourceKey?: string;
  sourceField?: string;
  targetColumn?: string;
  targetKey?: string;
  targetField?: string;
  hasRevisions?: boolean;
  cardinality?: 'one' | 'many';
  through?: JsonObject;
  joinTable?: string;
  isArray?: boolean;
}

export interface NormalizedRelationDefinition {
  name: string;
  config: RelationConfig;
}

type RelationDefinitionInput = NormalizedRelationDefinition | (RelationConfig & { name: string });

type InstanceMethod<TInstance extends ModelInstance> = (
  this: TInstance,
  ...args: unknown[]
) => unknown;

type StaticMethod = (...args: unknown[]) => unknown;

type RuntimeModel<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>,
> = ModelConstructor<TRecord, TVirtual, TInstance> & {
  defineRelation?: (name: string, config: RelationConfig) => void;
  define?: (name: string, handler: InstanceMethod<TInstance>) => void;
  prototype: TInstance;
  _registerFieldMapping?: (camel: string, snake: string) => void;
  dal?: { query: (text: string, params?: unknown[]) => Promise<unknown> };
  _createInstance?: (...args: unknown[]) => TInstance;
};

export interface InitializeModelResult<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>,
> {
  model: RuntimeModel<TRecord, TVirtual, TInstance>;
  isNew: boolean;
  tableName: string;
}

export interface InitializeModelOptions<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>,
> {
  dal: DataAccessLayer;
  baseTable: string;
  schema?: JsonObject;
  camelToSnake?: Record<string, string>;
  withRevision?: boolean | RevisionHandlerConfig | null;
  staticMethods?: Record<string, StaticMethod>;
  instanceMethods?: Record<string, InstanceMethod<TInstance>>;
  registryKey?: string;
  relations?: RelationDefinitionInput[] | Record<string, RelationConfig> | null;
}

/**
 * Normalize a value to an array while falling back to sensible defaults.
 * @param value Single value or array provided by the caller.
 * @param fallback Default array to use when the value is empty.
 * @returns Array form of the provided value or the fallback.
 */
const toArray = <T>(value: T | T[] | undefined | null, fallback: readonly T[]): readonly T[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value == null) {
    return fallback;
  }
  return [value];
};

/**
 * Translate a revision configuration into explicit handler lists so the
 * initializer can attach them deterministically.
 * @param config High-level revision configuration provided by callers.
 * @returns Normalized static and instance handler names, or null when disabled.
 */
function normalizeRevisionConfig(config: boolean | RevisionHandlerConfig | null | undefined): {
  static: readonly RevisionHandlerName[];
  instance: readonly RevisionHandlerName[];
} | null {
  if (config === true) {
    return { static: DEFAULT_REVISION_STATIC, instance: DEFAULT_REVISION_INSTANCE };
  }

  if (!config) {
    return null;
  }

  return {
    static: toArray(config.static, DEFAULT_REVISION_STATIC),
    instance: toArray(config.instance, DEFAULT_REVISION_INSTANCE),
  };
}

/**
 * Apply revision helpers to a model using the normalized handler lists.
 * @param model Runtime model constructor that should receive the handlers.
 * @param config Normalized configuration from {@link normalizeRevisionConfig}.
 */
function attachRevisionHandlers<
  TRecord extends JsonObject,
  TVirtual extends JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual>,
>(
  model: RuntimeModel<TRecord, TVirtual, TInstance>,
  config: {
    static: readonly RevisionHandlerName[];
    instance: readonly RevisionHandlerName[];
  } | null
): void {
  if (!config) {
    return;
  }

  for (const name of config.static) {
    const factory = REVISION_HANDLER_MAP[name];
    if (typeof factory === 'function') {
      const factoryTarget = model as unknown as ModelConstructorLike;
      model[name] = factory(factoryTarget);
    }
  }

  for (const name of config.instance) {
    const factory = REVISION_HANDLER_MAP[name];
    if (typeof factory !== 'function') {
      continue;
    }

    const factoryTarget = model as unknown as ModelConstructorLike;
    const handler = factory(factoryTarget) as InstanceMethod<TInstance>;
    if (typeof model.define === 'function') {
      model.define(name, handler);
    } else {
      const prototypeRecord = model.prototype as unknown as Record<string, unknown>;
      prototypeRecord[name] = handler;
    }
  }
}

/**
 * Convert relation definitions provided as either arrays or objects into a
 * canonical array representation.
 * @param relations Raw relation definitions from the model configuration.
 * @returns Normalized relation definitions safe for iteration.
 */
function normalizeRelationDefinitions(
  relations: RelationDefinitionInput[] | Record<string, RelationConfig> | null | undefined
): NormalizedRelationDefinition[] {
  if (!relations) {
    return [];
  }

  if (Array.isArray(relations)) {
    return relations
      .map(entry => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const entryObject = entry as unknown as Record<string, unknown>;
        const relationName = entryObject.name;
        if (typeof relationName !== 'string' || relationName.length === 0) {
          return null;
        }

        const { name: _ignored, ...rest } = entryObject;
        const normalizedConfig: RelationConfig = { ...rest } as RelationConfig;

        return { name: relationName, config: normalizedConfig };
      })
      .filter((entry): entry is NormalizedRelationDefinition => Boolean(entry));
  }

  return Object.entries(relations)
    .map(([name, config]) => {
      if (typeof name !== 'string' || name.length === 0) {
        return null;
      }

      const normalizedConfig: RelationConfig =
        config && typeof config === 'object' ? { ...config } : {};

      return { name, config: normalizedConfig };
    })
    .filter((entry): entry is NormalizedRelationDefinition => Boolean(entry));
}

/**
 * Register or fetch a model from the DAL, wiring up schema defaults, relations,
 * revision helpers, and custom methods along the way.
 * @param options Configuration describing the model's schema and hooks.
 * @returns Descriptor containing the runtime model, whether it was newly created, and the table name.
 */
export function initializeModel<
  TRecord extends JsonObject,
  TVirtual extends JsonObject = JsonObject,
  TInstance extends ModelInstance<TRecord, TVirtual> = ModelInstance<TRecord, TVirtual>,
>(
  options: InitializeModelOptions<TRecord, TVirtual, TInstance>
): InitializeModelResult<TRecord, TVirtual, TInstance> {
  const {
    dal,
    baseTable,
    schema = {},
    camelToSnake = {},
    withRevision = false,
    staticMethods = {},
    instanceMethods = {},
    registryKey,
    relations = null,
  } = options;

  if (!dal) {
    throw new Error('Model initialization requires a DAL instance');
  }

  if (!baseTable) {
    throw new Error('Model initialization requires a base table name');
  }

  const tableName = dal.schemaNamespace ? `${dal.schemaNamespace}${baseTable}` : baseTable;
  const schemaDefinition: JsonObject = { ...schema };

  if (withRevision) {
    Object.assign(schemaDefinition, revision.getSchema());
  }

  const { model, isNew } = getOrCreateModel<TRecord, TVirtual, TInstance>(
    dal,
    tableName,
    schemaDefinition,
    {
      registryKey: registryKey ?? baseTable,
    }
  );

  // Debugging: ensure revision handlers are attached when expected
  const runtimeModel = model as RuntimeModel<TRecord, TVirtual, TInstance>;
  const relationDefs = normalizeRelationDefinitions(relations);

  if (relationDefs.length > 0 && typeof runtimeModel.defineRelation === 'function') {
    for (const { name, config } of relationDefs) {
      runtimeModel.defineRelation(name, config);
    }
  }

  if (!isNew) {
    return { model: runtimeModel, isNew, tableName };
  }

  for (const [camel, snake] of Object.entries(camelToSnake)) {
    runtimeModel._registerFieldMapping?.(camel, snake);
  }

  const revisionConfig = normalizeRevisionConfig(withRevision);
  if (revisionConfig) {
    attachRevisionHandlers(runtimeModel, revisionConfig);
    revision.registerFieldMappings(runtimeModel as unknown as ModelConstructorLike);
  }

  for (const [name, fn] of Object.entries(staticMethods)) {
    if (typeof fn === 'function') {
      runtimeModel[name as keyof typeof runtimeModel] = fn as unknown;
    }
  }

  for (const [name, fn] of Object.entries(instanceMethods)) {
    if (typeof fn !== 'function') {
      continue;
    }

    const handler = fn as InstanceMethod<TInstance>;
    if (typeof runtimeModel.define === 'function') {
      runtimeModel.define(name, handler);
    } else {
      const prototypeRecord = runtimeModel.prototype as unknown as Record<string, unknown>;
      prototypeRecord[name] = handler;
    }
  }

  return { model: runtimeModel, isNew, tableName };
}

const initializer = { initializeModel };

export { initializer as default };
