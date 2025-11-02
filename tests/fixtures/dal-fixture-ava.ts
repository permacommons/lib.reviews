import { randomUUID } from 'crypto';
import { logNotice, logOK } from '../helpers/test-helpers.ts';
import { createTestHarness } from '../../bootstrap/dal.ts';
import pgModule from 'pg';
import { initializeModel } from '../../dal/lib/model-initializer.ts';
import type { DataAccessLayer, ModelConstructor } from '../../dal/lib/model-types.ts';

type ThingModel = typeof import('../../models/thing.ts').default;
type ThingSlugModel = typeof import('../../models/thing-slug.ts').default;
type ReviewModel = typeof import('../../models/review.ts').default;
type UserModel = typeof import('../../models/user.ts').default;
type FileModel = typeof import('../../models/file.ts').default;
type TeamModel = typeof import('../../models/team.ts').default;
type TeamSlugModel = typeof import('../../models/team-slug.ts').default;
type TeamJoinRequestModel = typeof import('../../models/team-join-request.ts').default;

type KnownModels = {
  Thing: ThingModel;
  ThingSlug: ThingSlugModel;
  Review: ReviewModel;
  User: UserModel;
  File: FileModel;
  Team: TeamModel;
  TeamSlug: TeamSlugModel;
  TeamJoinRequest: TeamJoinRequestModel;
};

type KnownModelAlias = keyof KnownModels;

const KNOWN_MODEL_BASE_NAMES: Record<KnownModelAlias, string> = {
  Thing: 'things',
  ThingSlug: 'thing_slugs',
  Review: 'reviews',
  User: 'users',
  File: 'files',
  Team: 'teams',
  TeamSlug: 'team_slugs',
  TeamJoinRequest: 'team_join_requests'
};

type TableDefinition = {
  name: string;
  sql: string;
  indexes?: string[];
};

type BootstrapOptions = {
  env?: Record<string, string | undefined>;
  tableDefs?: unknown;
  modelDefs?: unknown;
  cleanupTables?: string[];
};

type ModelDescriptor =
  | string
  | {
      key?: string;
      alias?: string;
      as?: string;
      name?: string;
      table?: string;
      identifier?: string;
      schema?: unknown;
      camelToSnake?: boolean;
      hasRevisions?: boolean;
      staticMethods?: Record<string, (...args: unknown[]) => unknown>;
      instanceMethods?: Record<string, (...args: unknown[]) => unknown>;
      registryKey?: string;
    };

/**
 * AVA-compatible PostgreSQL DAL fixture for testing
 *
 * Designed to work with AVA's concurrency model (concurrency: 4) by:
 * - Targeting the shared test database (`libreviews_test`) while isolating each
 *   worker in its own schema (e.g., `test_feature_x`)
 * - Prefixing table names to avoid conflicts between concurrent tests
 * - Providing proper cleanup and connection management
 * - Supporting test isolation with atomic transactions
 */
const BASE_TO_KNOWN_ALIAS = Object.fromEntries(
  Object.entries(KNOWN_MODEL_BASE_NAMES).map(([alias, base]) => [base, alias as KnownModelAlias])
) as Record<string, KnownModelAlias>;

export interface TestUserHandle {
  id: string;
  actor: {
    id: string;
    is_super_user: boolean;
    is_trusted: boolean;
  };
}

const sanitizeIdentifier = (value: unknown) => {
  if (!value) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
};

class DALFixtureAVA {
  instanceKey: string;
  namespace: string;
  schemaName: string;
  dal: DataAccessLayer | null;
  harness: any;
  models: Record<string, ModelConstructor>;
  customModels: Map<string, ModelConstructor>;
  userModel: UserModel | null;
  loaded: boolean;
  testInstance: string;
  schemaNamespace: string;
  connected: boolean;
  bootstrapError: unknown;
  skipReason: string | null;
  managedTables: string[];
  private knownModels: Partial<KnownModels>;

  constructor(testInstance: string = 'testing-2', options: { schemaNamespace?: string } = {}) {
    const { schemaNamespace } = options;
    const instanceKey = sanitizeIdentifier(testInstance) || 'testing_2';
    const namespaceKey = sanitizeIdentifier(schemaNamespace);
    this.instanceKey = instanceKey;
    this.namespace = namespaceKey || instanceKey;
    this.schemaName = `test_${this.namespace}`;
    this.dal = null;
    this.harness = null;
    this.models = {};
    this.customModels = new Map<string, ModelConstructor>();
    this.userModel = null;
    this.loaded = false;
    this.testInstance = testInstance;
    this.schemaNamespace = `${this.schemaName}.`;
    this.connected = false;
    this.bootstrapError = null;
    this.skipReason = null;
    this.managedTables = [];
    this.knownModels = {};
  }

  /**
   * Bootstrap the DAL with PostgreSQL connection and models
   * Uses NODE_APP_INSTANCE to determine which test database to connect to
   * @param {Object|Array} [options] - Bootstrap options or legacy model definitions array
   */
  async bootstrap(options: unknown = []) {
    this.bootstrapError = null;
    this.skipReason = null;

    const legacyModelDefs = Array.isArray(options) ? options : null;
    const normalizedOptions: BootstrapOptions =
      options && !Array.isArray(options) ? { ...(options as BootstrapOptions) } : {};
    if (legacyModelDefs) {
      normalizedOptions.modelDefs = legacyModelDefs;
    }

    const envDefaults = {
      NODE_ENV: 'development',
      NODE_CONFIG_DISABLE_WATCH: 'Y',
      NODE_APP_INSTANCE: this.testInstance
    };

    const envConfig = { ...envDefaults, ...(normalizedOptions.env || {}) };

    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === 'string') {
        process.env[key] = value;
      }
    }

    logNotice(`Loading PostgreSQL DAL configuration for AVA instance ${this.testInstance}.`);

    let harness: any;
    try {
      harness = await createTestHarness({
        schemaName: this.schemaName,
        schemaNamespace: this.schemaNamespace,
        registerModels: true
      });
    } catch (error) {
      this.bootstrapError = error;
      this.skipReason = error.message || 'Failed to initialize PostgreSQL harness';
      logNotice(`PostgreSQL connection unavailable for AVA tests: ${this.skipReason}`);
      return;
    }

    this.harness = harness;
    this.dal = harness.dal as DataAccessLayer;
    this.schemaNamespace = (harness.schemaNamespace as string | undefined) || this.schemaNamespace;
    this.connected = true;
    this.models = Object.fromEntries(harness.registeredModels) as Record<string, ModelConstructor>;
    for (const alias of Object.keys(this.models)) {
      this.cacheKnownModel(alias, this.models[alias]);
      this.cacheKnownModelByBase(alias, this.models[alias]);
    }
    this.customModels = new Map<string, ModelConstructor>();

    logOK('PostgreSQL DAL connected for AVA tests.');

    const modelDefinitions = Array.isArray(normalizedOptions.modelDefs)
      ? normalizedOptions.modelDefs
      : [];

    if (modelDefinitions.length > 0) {
      logNotice('Creating DAL models for AVA tests.');

      for (const modelDef of modelDefinitions) {
        const { model } = initializeModel({
          dal: this.dal,
          baseTable: modelDef.name,
          schema: modelDef.schema,
          camelToSnake: modelDef.camelToSnake,
          withRevision: modelDef.hasRevisions
            ? {
              static: [
                'createFirstRevision',
                'getNotStaleOrDeleted',
                'filterNotStaleOrDeleted',
                'getMultipleNotStaleOrDeleted'
              ],
              instance: ['newRevision', 'deleteAllRevisions']
            }
            : false,
          staticMethods: modelDef.staticMethods,
          instanceMethods: modelDef.instanceMethods,
          registryKey: modelDef.registryKey || modelDef.name
        });

        this.customModels.set(modelDef.name, model as ModelConstructor);
        this.models[modelDef.name] = model;
      }

      logOK(`Created ${modelDefinitions.length} DAL models for AVA tests.`);
    }

    const tableDefinitions = normalizedOptions.tableDefs as TableDefinition[] | undefined;
    if (Array.isArray(tableDefinitions) && tableDefinitions.length > 0) {
      await this.createTestTables(tableDefinitions);
      const managed = tableDefinitions
        .map(def => def?.name)
        .filter(Boolean);
      if (managed.length > 0) {
        const unique = new Set([...this.managedTables, ...managed]);
        this.managedTables = Array.from(unique);
      }
    }

    this.loaded = true;
    logOK('AVA DAL fixture ready. 🚀');
  }

  /**
   * Clean up test tables and data with proper isolation
   * Uses transactions to ensure atomic cleanup between tests
   * @param {Array} tableNames - Names of tables to clean up (without prefix)
   */
  async cleanupTables(tableNames: string[] = []) {
    if (!this.dal || !this.connected) return;

    if (!Array.isArray(tableNames) || tableNames.length === 0) return;

    const qualifiedTables = tableNames.map(name => `${this.schemaNamespace}${name}`);
    try {
      await this.dal.query(
        `TRUNCATE ${qualifiedTables.join(', ')} RESTART IDENTITY CASCADE`
      );
    } catch (error) {
      console.warn(`Warning: Failed to truncate tables ${qualifiedTables.join(', ')}:`, error.message);
    }
  }

  /**
   * Create test tables for models with proper prefixing
   * @param {Array} tableDefinitions - Array of table creation definitions
   */
  async createTestTables(tableDefinitions: TableDefinition[] = []) {
    if (!this.dal || !this.connected) return;
    if (!Array.isArray(tableDefinitions) || tableDefinitions.length === 0) return;

    for (const tableDef of tableDefinitions) {
      const baseName = tableDef.name;
      const fullTableName = `${this.schemaNamespace}${baseName}`;
      try {
        const tableRegex = new RegExp(`\\b${baseName}\\b`, 'g');
        const createSql = tableDef.sql.replace(tableRegex, fullTableName);
        await this.dal.query(createSql);

        if (tableDef.indexes) {
          for (const indexSql of tableDef.indexes) {
            const prefixedIndexSql = indexSql
              .replace(tableRegex, fullTableName)
              .replace(/idx_([a-zA-Z0-9_]+)/g, `idx_${this.namespace}_$1`);
            await this.dal.query(prefixedIndexSql);
          }
        }
      } catch (error) {
        if (!error.message.includes('already exists')) {
          throw error;
        }
      }
    }
  }

  /**
   * Drop test tables with proper prefixing
   * @param {Array} tableNames - Names of tables to drop (without prefix)
   */
  async dropTestTables(tableNames: string[] = []) {
    if (!this.dal || !this.connected) return;

    for (const tableName of tableNames) {
      const fullTableName = this.schemaNamespace + tableName;
      try {
        await this.dal.query(`DROP TABLE IF EXISTS ${fullTableName} CASCADE`);
      } catch (error) {
        console.warn(`Warning: Failed to drop table ${fullTableName}:`, error.message);
      }
    }
  }

  /**
   * Clean up the DAL fixture
   */
  async cleanup(options: { dropTables?: boolean } = {}) {
    logNotice('Cleaning up PostgreSQL DAL for AVA tests.');

    if (this.dal && this.connected && this.managedTables.length > 0) {
      const shouldDrop = options.dropTables !== false;
      if (shouldDrop) {
        const toDrop = [...this.managedTables].reverse();
        await this.dropTestTables(toDrop);
        this.managedTables = [];
      }
    }

    if (this.harness) {
      try {
        await this.harness.cleanup(options);
        logOK('PostgreSQL DAL disconnected for AVA tests.');
      } catch (error) {
        console.error('Failed to disconnect DAL harness:', error);
      }
    }

    this.harness = null;
    this.dal = null;
    this.connected = false;
    this.models = {};
    this.customModels = new Map<string, ModelConstructor>();
    this.userModel = null;
    this.loaded = false;
    this.bootstrapError = null;
    this.skipReason = null;
    this.knownModels = {};

    try {
      const pg = pgModule;
      if (pg?.pools?.all) {
        await Promise.all(Array.from(pg.pools.all).map(async ([, pool]) => {
          try {
            await pool.end();
          } catch {}
        }));
        pg.pools.all.clear?.();
      }
      if (pg && pg._pools && typeof pg._pools.forEach === 'function') {
        for (const pool of pg._pools) {
          try {
            await pool.end();
          } catch {}
        }
        if (typeof pg._pools.clear === 'function') {
          pg._pools.clear();
        }
      }
      if (typeof pg.end === 'function') {
        await pg.end().catch(() => {});
      }
    } catch {}

    const processWithHandles = process as NodeJS.Process & { _getActiveHandles?: () => unknown[] };
    const getActiveHandles = processWithHandles._getActiveHandles?.bind(process);
    if (typeof getActiveHandles === 'function') {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const sockets = getActiveHandles().filter(handle => handle?.constructor?.name === 'Socket');
        if (sockets.length === 0) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  /**
   * Get a model by name
   * @param {string} name - Model name (without prefix)
   * @returns {Object} Model class
   */
  getModel(name: string): ModelConstructor | undefined {
    if (this.customModels.has(name)) {
      return this.customModels.get(name);
    }

    if (this.models[name]) {
      return this.models[name];
    }

    if (!this.dal || !this.connected) {
      return undefined;
    }

    try {
      const model = this.dal.getModel(name);
      if (model) {
        this.models[name] = model as ModelConstructor;
        this.cacheKnownModelByBase(name, model as ModelConstructor);
      }
      return model;
    } catch (error) {
      const notFound = /Model '.*' not found/.test(error?.message || '');
      if (notFound) {
        return undefined;
      }
      throw error;
    }
  }

  private isKnownAlias(value: string): value is KnownModelAlias {
    return Object.prototype.hasOwnProperty.call(KNOWN_MODEL_BASE_NAMES, value);
  }

  private cacheKnownModel(alias: string | null | undefined, model: ModelConstructor | null | undefined): void {
    if (!alias || !model || !this.isKnownAlias(alias)) {
      return;
    }
    this.knownModels[alias] = model as KnownModels[KnownModelAlias];
  }

  private cacheKnownModelByBase(baseName: string | null | undefined, model: ModelConstructor | null | undefined): void {
    if (!baseName || !model) {
      return;
    }
    const alias = BASE_TO_KNOWN_ALIAS[baseName];
    if (alias) {
      this.cacheKnownModel(alias, model);
    }
  }

  private requireKnownModel<A extends KnownModelAlias>(alias: A): KnownModels[A] {
    const cached = this.knownModels[alias];
    if (cached) {
      return cached;
    }
    const baseName = KNOWN_MODEL_BASE_NAMES[alias];
    const model = this.getModel(baseName);
    if (!model) {
      throw new Error(`Model '${baseName}' has not been initialized in the DAL fixture.`);
    }
    const typedModel = model as KnownModels[A];
    this.knownModels[alias] = typedModel;
    return typedModel;
  }

  get Thing(): ThingModel {
    return this.requireKnownModel('Thing');
  }

  get ThingSlug(): ThingSlugModel {
    return this.requireKnownModel('ThingSlug');
  }

  get Review(): ReviewModel {
    return this.requireKnownModel('Review');
  }

  get User(): UserModel {
    return this.requireKnownModel('User');
  }

  get File(): FileModel {
    return this.requireKnownModel('File');
  }

  get Team(): TeamModel {
    return this.requireKnownModel('Team');
  }

  get TeamSlug(): TeamSlugModel {
    return this.requireKnownModel('TeamSlug');
  }

  get TeamJoinRequest(): TeamJoinRequestModel {
    return this.requireKnownModel('TeamJoinRequest');
  }

  getThingModel(): ThingModel {
    return this.Thing;
  }

  getThingSlugModel(): ThingSlugModel {
    return this.ThingSlug;
  }

  getReviewModel(): ReviewModel {
    return this.Review;
  }

  getUserModel(): UserModel {
    return this.User;
  }

  getFileModel(): FileModel {
    return this.File;
  }

  getTeamModel(): TeamModel {
    return this.Team;
  }

  getTeamSlugModel(): TeamSlugModel {
    return this.TeamSlug;
  }

  getTeamJoinRequestModel(): TeamJoinRequestModel {
    return this.TeamJoinRequest;
  }

  /**
   * Execute a raw query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise} Query result
   */
  async query(sql: string, params: unknown[] = []) {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }
    return await this.dal.query(sql, params);
  }

  /**
   * Get the full table name with prefix
   * @param {string} tableName - Base table name
   * @returns {string} Full table name with prefix
   */
  getTableName(tableName: string) {
    return this.schemaNamespace + tableName;
  }

  /**
   * Create a barebones test user directly in the schema
   * @param {string} namePrefix
   * @returns {{id: string, is_super_user: boolean, is_trusted: boolean}}
   */
  async createTestUser(namePrefix = 'Test User'): Promise<TestUserHandle> {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }

    if (!this.userModel) {
      this.userModel = this.getUserModel();
    }

    const uuid = randomUUID();
    const name = `${namePrefix} ${uuid.slice(0, 8)}`;

    const user = await this.userModel.create({
      name,
      password: 'secret123',
      email: `${uuid}@example.com`
    });

    const handle: TestUserHandle = {
      id: user.id,
      actor: {
        id: user.id,
        is_super_user: false,
        is_trusted: true
      }
    };

    return handle;
  }

  /**
   * Return true if the fixture has an active PostgreSQL connection
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Retrieve the reason why bootstrap skipped connecting
   * @returns {string|null}
   */
  getSkipReason() {
    return this.skipReason;
  }

  /**
   * Initialize real PostgreSQL models using their initializer functions.
   * Each initializer receives the DAL instance so it can attach to the same
   * connection pool and honor table prefixes for isolation.
   * @param {Array} loaders - Array of loader configs or functions
   * @returns {Object} Map of loaded models keyed by base table name
   */
  async initializeModels(descriptors: ModelDescriptor[] = []): Promise<Record<string, ModelConstructor>> {
    if (!this.dal || !this.connected) {
      throw new Error('DAL not initialized');
    }

    const results: Record<string, any> = {};

    for (const entry of descriptors) {
      if (!entry) continue;

      let key;
      let alias;

      if (typeof entry === 'string') {
        key = entry;
        alias = entry;
      } else if (typeof entry === 'object') {
        key = entry.key || entry.name || entry.table || entry.identifier;
        alias = entry.alias || entry.as || entry.key || entry.name;
      }

      if (!key) {
        continue;
      }

      const model = this.getModel(key);
      if (!model) {
        continue;
      }

      const aliasKey = alias || key;
      this.models[aliasKey] = model;
      if (!this.models[key]) {
        this.models[key] = model;
      }
      results[aliasKey] = model;
      this.cacheKnownModel(aliasKey, model);
      this.cacheKnownModelByBase(key, model);
    }

    return results;
  }
}

export const createDALFixtureAVA = (testInstance: string = 'testing-2', options: { schemaNamespace?: string } = {}) =>
  new DALFixtureAVA(testInstance, options);

export default DALFixtureAVA;
