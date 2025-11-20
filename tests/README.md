# PostgreSQL Test Harness

## Prerequisites

Complete the Database Setup steps in `CONTRIBUTING.md` before running these tests.
This covers creating the `libreviews` and `libreviews_test` databases, granting
privileges (via `dal/setup-db-grants.sql`), installing extensions, and priming
the schema. Once those steps are done you can boot the app or execute the test
suite without additional setup.

## Harness Architecture

The `setupPostgresTest` helper (`tests/helpers/setup-postgres-test.ts`) wires
AVA into the shared PostgreSQL DAL bootstrap (`bootstrap/dal.ts`):

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

```ts
import test from 'ava';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

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
  readiness check in `run-ava.ts` rather than being skipped individually.

## Running the Suite

```bash
npm run test
```

`tests/run-ava.ts` performs the following:

1. Checks if the Vite manifest exists (triggering `npm run build:frontend` on demand)
2. **Checks PostgreSQL DAL readiness** - tests will exit immediately if PostgreSQL
   is not available or not properly configured
3. Sets the required environment variables (`NODE_APP_INSTANCE=testing`)
4. Executes AVA with the `tests/[0-9]*-*.ts` pattern

Concurrency is controlled by AVA (via config or CPU cores). Use AVA's `--concurrency` flag
to adjust worker count as needed.

To see detailed debug output during test runs, set `DEBUG` to the relevant namespaces:

- Everything: `DEBUG=libreviews:* npm run test`
- DAL/tests only: `DEBUG=libreviews:db,libreviews:tests npm run test -- --match "<pattern>"`

## Caveats & Best Practices

- Use unique `schemaNamespace` values per test file to avoid schema name clashes.
- For suites that share mutable tables across tests, prefer `test.serial` or
  isolate the work by giving each test its own schema namespace.
- If you add asynchronous teardown logic outside the fixture, await it inside a
  `test.after.always` hook; otherwise AVA reports “Failed to exit” timeouts.

## Shared DAL/unit mocks for fast, typed unit tests

Use the consolidated helpers in `tests/helpers/dal-mocks.ts` to avoid re-implementing light-weight DAL/model stubs in each suite.

Typical usage patterns:

```ts
import test from 'ava';
import {
  createQueryBuilderHarness,
  createMockDAL,
  createQueryResult
} from './helpers/dal-mocks.ts';

// 1) QueryBuilder harness for unit tests (no DB)
test('QueryBuilder can be instantiated', t => {
  const { qb } = createQueryBuilderHarness(); // model + query builder + mock DAL
  t.truthy(qb);
});

// 2) Overriding DAL.query in a focused test
test('Model constructor maps camelCase fields to snake_case columns', async t => {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const mockDAL = createMockDAL({
    async query<TRecord>(sql: string, params: unknown[] = []) {
      captured.push({ sql, params });
      // Provide a row compatible with caller expectations while satisfying generics
      const row = { id: 'generated-id', camel_case_field: params[0] } as unknown as TRecord;
      return createQueryResult<TRecord>([row]);
    }
  });

  // ... initialize a model with mockDAL, run code under test, assert captured queries
});
```

Guidelines:

- Keep query return types generic. When a test needs to synthesize a row, construct a structural object and coerce through `unknown` to `TRecord`. This matches the `DataAccessLayer.query<TRecord>` contract and avoids “could be a different subtype” warnings.
- Prefer `createQueryBuilderHarness()` for pure QueryBuilder tests. It wires a default schema and registers the model in the mock DAL registry so joins and metadata work without a database.
- If a test needs to check SQL/params, override `query` in the `createMockDAL({...})` call and push captured entries into a local array.

## COUNT(*) and aggregate result patterns

node-postgres returns `COUNT(*)` as text in most configurations. Convert at the call site in tests:

- Use `Number(row.count)` when a numeric value is expected.
- Or, if you want `parseInt`, wrap with `String(...)` and pass radix: `parseInt(String(row.count), 10)`.

Examples are used in tests like `tests/10-dal-revision-system.ts`.

## Search mocking and guards

The shared search mock in `tests/helpers/mock-search.ts` provides:
- Typed shapes for indexed items (review vs thing) with discriminators.
- Guards that match the minimal shape used by tests rather than full backend response types.

Import and call `mockSearch()` in `test.before` when a suite relies on search, and `unmockSearch()` in `test.after.always`.

## Integration agent typing

Use the supertest agent types in `tests/types/integration.ts`:
- `AgentLike` for functions that accept either an agent or supertest-compatible interface.
- `AgentWithOptionalClose` when a suite may call `.close?.()` during teardown.

This keeps helpers reusable across integration suites without over-constraining the agent type.

## PostgreSQL fixture recap

For DB-backed suites, `setupPostgresTest` (see the top of this README) remains the source of truth:
- It bootstraps the shared DAL, sets up a per-worker schema prefix, and exposes a `dalFixture`.
- Use `dalFixture.initializeModels([...])` to load real models that honor the schema prefix.
- Use `dalFixture.createTestUser()` to seed authenticated actors.

Teardown:

- The DAL harness is cleaned up for you via the fixture. We avoid poking `pg` internals; if available, a single global `pg.end()` is invoked as a stable API to ensure pools are drained. A brief socket-drain loop remains to prevent “open handles” flakes in CI.

## Conventions and lint-friendly patterns

- Avoid ambient tightening to satisfy external augmentations. Accept broader third‑party shapes at boundaries (e.g., Express Request fields), then validate and narrow at the use site.
- Keep shared test helpers small and typed. Favor concise coercions at the edges over pervasive union annotations in shared types.
- Where mocks need to satisfy generics, cast via `unknown` to the generic type parameter as a local, intentional escape hatch for test doubles.
