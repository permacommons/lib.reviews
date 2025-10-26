# PostgreSQL Test Harness

The files in this directory exercise the in-progress PostgreSQL DAL and models.
They run independently from the legacy RethinkDB suites under `tests-legacy/`
and use the AVA runner in `tests/run-ava.mjs`.

## Prerequisites

Complete the steps in `POSTGRES-SETUP.md` before running these tests. That
document covers creating the `libreviews` and `libreviews_test` databases,
granting privileges (via `dal/setup-db-grants.sql`), installing extensions, and
priming the schema. Once those steps are done you can boot the app or execute
the test suite without additional setup.

## Harness Architecture

The `setupPostgresTest` helper (`tests/helpers/setup-postgres-test.mjs`) wires
AVA into the shared PostgreSQL DAL bootstrap (`bootstrap/dal.js`):

- It sets `NODE_APP_INSTANCE=testing`, which loads the `libreviews_test`
  connection settings from `config/development-testing.json5`.
- During bootstrap the harness runs migrations, registers the default models,
  and exposes a `dalFixture` with helpers for queries, model access, and data
  creation.
- Each worker receives its own schema (for example `test_my_feature`) and a
  matching table prefix, so concurrent workers can exercise the same tables
  without clobbering each other. Schemas are dropped during teardown.

## Writing PostgreSQL Tests

Use the shared helper to provision a fixture and skip cleanly when PostgreSQL is
unavailable:

```js
import test from 'ava';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
  tableSuffix: 'feature-under-test',
  cleanupTables: ['users', 'things']
});

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  const { User } = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' }
  ]);

  t.context.models = { User };
});
```

Key capabilities:

- `dalFixture.initializeModels([...])` loads real models through their
  initializer functions while honoring the worker-specific table prefix.
- `dalFixture.createTestUser()` provisions a user (and actor stub) backed by
  the prefixed tables, making it easy to seed data.
- `cleanupTables` truncates the listed tables before each test. Omit it only if
  the suite handles cleanup manually.
- `skipIfUnavailable(t)` logs the initialization failure and short-circuits the
  test when PostgreSQL is unreachable (for example, in CI jobs that do not
  provision the database service).

## Running the Suite

```bash
npm run test-postgres
```

`tests/run-ava.mjs` ensures the Vite manifest exists (triggering `npm run build`
on demand), sets the required environment variables, and executes AVA with the
`tests/[0-9]*-*.mjs` pattern. The runner defaults to four workers; use AVA’s
`--concurrency` flag if you need to scale it down.

## Caveats & Best Practices

- Use unique `tableSuffix` values per test file to avoid schema name clashes.
- For suites that share mutable tables across tests, prefer `test.serial` or
  isolate the work by giving each test its own table suffix.
- When stubbing modules (for example `../search`), remove them from
  `require.cache` in an `after.always` hook so the next test sees the real
  implementation.
- If you add asynchronous teardown logic outside the fixture, await it inside a
  `test.after.always` hook; otherwise AVA reports “Failed to exit” timeouts.
