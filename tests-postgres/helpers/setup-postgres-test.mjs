import { createDALFixtureAVA } from '../fixtures/dal-fixture-ava.mjs';

const DEFAULT_ENV = {
  NODE_ENV: 'development',
  NODE_CONFIG_DISABLE_WATCH: 'Y',
  LIBREVIEWS_SKIP_RETHINK: '1'
};

const resolveMaybeAsync = async value => {
  if (typeof value === 'function') {
    return await value();
  }
  return await value;
};

export function setupPostgresTest(test, options = {}) {
  const {
    tableSuffix,
    env = {},
    tableDefs,
    modelDefs,
    cleanupTables = []
  } = options;

  const dalFixture = createDALFixtureAVA('testing', { tableSuffix });
  const finalEnv = {
    ...DEFAULT_ENV,
    NODE_APP_INSTANCE: 'testing',
    ...env
  };

  for (const [key, value] of Object.entries(finalEnv)) {
    if (value === undefined) continue;
    process.env[key] = value;
  }

  test.before(async t => {
    try {
      const resolvedTableDefs = await resolveMaybeAsync(tableDefs);
      const resolvedModelDefs = await resolveMaybeAsync(modelDefs);
      await dalFixture.bootstrap({
        env: finalEnv,
        tableDefs: resolvedTableDefs,
        modelDefs: resolvedModelDefs
      });
    } catch (error) {
      t.log(
        `PostgreSQL not available for ${instance} (${tableSuffix || 'default'}): ${
          error?.message || 'unknown error'
        }`
      );
      t.pass('Skipping tests - PostgreSQL not configured');
    }
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

  return {
    dalFixture,
    skipIfUnavailable(t, message = 'Skipping - PostgreSQL DAL not available') {
      if (!dalFixture.isConnected()) {
        t.pass(message);
        return true;
      }
      return false;
    }
  };
}
