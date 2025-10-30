# PostgreSQL Test Harness

## Prerequisites

Complete the Database Setup steps in `CONTRIBUTING.md` before running these tests.
This covers creating the `libreviews` and `libreviews_test` databases, granting
privileges (via `dal/setup-db-grants.sql`), installing extensions, and priming
the schema. Once those steps are done you can boot the app or execute the test
suite without additional setup.

## Harness Architecture

The `setupPostgresTest` helper (`tests/helpers/setup-postgres-test.mjs`) wires
AVA into the shared PostgreSQL DAL bootstrap (`bootstrap/dal.mjs`):

- It sets `NODE_APP_INSTANCE=testing`, which loads the `libreviews_test`
  connection settings from `config/development-testing.json5`.
- During bootstrap the harness runs migrations, registers the default models,
  and exposes a `dalFixture` with helpers for queries, model access, and data
  creation.
- Each worker receives its own schema (for example `test_my_feature`) and a
  matching table prefix, so concurrent workers can exercise the same tables
  without clobbering each other. Schemas are dropped during teardown.

## Writing PostgreSQL Tests

Use the shared helper to provision a fixture:

```js
import test from 'ava';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'feature-under-test',
  cleanupTables: ['users', 'things']
});

// If your test file has its own test.before hook that uses dalFixture:
test.before(async () => {
  await bootstrapPromise; // Ensure DAL is ready first

  const { User } = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' }
  ]);

  // Store models for use in tests
});
```

Key capabilities:

- `dalFixture.initializeModels([...])` loads real models through their
  initializer functions while honoring the worker-specific table prefix.
- `dalFixture.createTestUser()` provisions a user (and actor stub) backed by
  the prefixed tables, making it easy to seed data.
- `cleanupTables` truncates the listed tables before each test. Omit it only if
  the suite handles cleanup manually.
- `bootstrapPromise` should be awaited in any test.before hook that uses
  dalFixture to ensure the DAL initialization is complete.
- **Note:** If PostgreSQL is unavailable, tests will fail immediately during the
  readiness check in `run-ava.mjs` rather than being skipped individually.

## Running the Suite

```bash
npm run test
```

`tests/run-ava.mjs` performs the following:

1. Checks if the Vite manifest exists (triggering `npm run build` on demand)
2. **Checks PostgreSQL DAL readiness** - tests will exit immediately if PostgreSQL
   is not available or not properly configured
3. Sets the required environment variables (`NODE_APP_INSTANCE=testing`)
4. Executes AVA with the `tests/[0-9]*-*.mjs` pattern

The runner defaults to four workers; use AVA's `--concurrency` flag if you need
to scale it down.

## Caveats & Best Practices

- Use unique `schemaNamespace` values per test file to avoid schema name clashes.
- For suites that share mutable tables across tests, prefer `test.serial` or
  isolate the work by giving each test its own schema namespace.
- When stubbing modules (for example `../search`), remove them from
  `require.cache` in an `after.always` hook so the next test sees the real
  implementation.
- If you add asynchronous teardown logic outside the fixture, await it inside a
  `test.after.always` hook; otherwise AVA reports “Failed to exit” timeouts.
