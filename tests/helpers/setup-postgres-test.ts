import type { TestFn } from 'ava';
import type DALFixtureAVA from '../fixtures/dal-fixture-ava.ts';
import { createDALFixtureAVA } from '../fixtures/dal-fixture-ava.ts';

type MaybeAsync<T> = T | (() => T | Promise<T>) | Promise<T>;

interface SetupOptions {
  schemaNamespace?: string;
  env?: Record<string, string | undefined>;
  tableDefs?: MaybeAsync<unknown>;
  modelDefs?: MaybeAsync<unknown>;
  cleanupTables?: string[];
}

const DEFAULT_ENV = {
  NODE_ENV: 'development',
  NODE_CONFIG_DISABLE_WATCH: 'Y',
};

const resolveMaybeAsync = async <T>(value: MaybeAsync<T> | undefined): Promise<T | undefined> => {
  if (value === undefined) return undefined;
  if (typeof value === 'function') {
    return await (value as () => T | Promise<T>)();
  }
  return await value;
};

export function setupPostgresTest(
  test: TestFn,
  options: SetupOptions = {}
): {
  dalFixture: DALFixtureAVA;
  bootstrapPromise: Promise<void>;
} {
  const { schemaNamespace, env = {}, tableDefs, modelDefs, cleanupTables = [] } = options;

  const namespace = schemaNamespace;
  const dalFixture = createDALFixtureAVA('testing', { schemaNamespace: namespace });
  const finalEnv = {
    ...DEFAULT_ENV,
    NODE_APP_INSTANCE: 'testing',
    ...env,
  };

  for (const [key, value] of Object.entries(finalEnv)) {
    if (value === undefined) continue;
    process.env[key] = value;
  }

  const bootstrapPromise = (async () => {
    try {
      const resolvedTableDefs = await resolveMaybeAsync(tableDefs);
      const resolvedModelDefs = await resolveMaybeAsync(modelDefs);
      await dalFixture.bootstrap({
        env: finalEnv,
        tableDefs: resolvedTableDefs,
        modelDefs: resolvedModelDefs,
      });
    } catch (error) {
      dalFixture.bootstrapError = error;
      dalFixture.skipReason = error?.message || 'Failed to initialize PostgreSQL harness';
      throw error;
    }
  })();

  test.before(async () => {
    await bootstrapPromise;
  });

  if (cleanupTables.length > 0) {
    test.beforeEach(async () => {
      if (!dalFixture.isConnected()) return;
      await dalFixture.cleanupTables(cleanupTables);
    });
  }

  test.after.always(async () => {
    await dalFixture.cleanup();
  });

  return { dalFixture, bootstrapPromise };
}
