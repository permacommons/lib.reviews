import { createDALFixtureAVA } from '../fixtures/dal-fixture-ava.mjs';

const DEFAULT_ENV = {
  NODE_ENV: 'development',
  NODE_CONFIG_DISABLE_WATCH: 'Y'
};

const resolveMaybeAsync = async value => {
  if (typeof value === 'function') {
    return await value();
  }
  return await value;
};

export function setupPostgresTest(test, options = {}) {
  const {
    schemaNamespace,
    env = {},
    tableDefs,
    modelDefs,
    cleanupTables = []
  } = options;

  const namespace = schemaNamespace;
  const dalFixture = createDALFixtureAVA('testing', { schemaNamespace: namespace });
  const finalEnv = {
    ...DEFAULT_ENV,
    NODE_APP_INSTANCE: 'testing',
    ...env
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
        modelDefs: resolvedModelDefs
      });
    } catch (error) {
      dalFixture.bootstrapError = error;
      dalFixture.skipReason = error?.message || 'Failed to initialize PostgreSQL harness';
      throw error;
    }
  })();

  test.before(async t => {
    try {
      await bootstrapPromise;
    } catch (error) {
      const instanceName = dalFixture?.testInstance || 'testing';
      const errorMessage = error?.message || 'unknown error';
      const skipNamespace = namespace || 'default';
      const skipMessage = `PostgreSQL not available for ${instanceName} (${skipNamespace}): ${errorMessage}`;
      t.log(skipMessage);
      if (error?.stack) {
        t.log(error.stack);
      }
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
    async skipIfUnavailable(t, message = 'Skipping - PostgreSQL DAL not available') {
      if (!dalFixture.isConnected()) {
        await bootstrapPromise.catch(() => {});
      }

      if (!dalFixture.isConnected()) {
        const stack = dalFixture.bootstrapError?.stack;
        if (stack) {
          t.log(stack);
        }
        const reason = dalFixture.getSkipReason?.() || dalFixture.bootstrapError?.message;
        if (reason) {
          t.log(`Skip reason: ${reason}`);
        }
        t.log(message);
        t.pass(message);
        return true;
      }
      return false;
    }
  };
}
