# PostgreSQL Test Harness

The files in this directory exercise the in-progress PostgreSQL DAL and models.
They run independently from the legacy RethinkDB tests under `tests/` and use a
dedicated AVA wrapper (`npm run test-postgres`). The harness sets `LIBREVIEWS_SKIP_RETHINK=1`, so no RethinkDB
connections are opened while the Postgres suite runs.

## Database Setup Requirements

The PostgreSQL tests require proper database setup with appropriate permissions:

### 1. Create Test Database

Create a single test database for the entire test suite:

```sql
CREATE DATABASE libreviews_test;
```

### 2. Grant Permissions

Grant full permissions to your PostgreSQL user (replace `libreviews_user` with your username):

```sql
-- Grant database-level permissions
GRANT ALL PRIVILEGES ON DATABASE libreviews_test TO libreviews_user;

-- Grant schema-level permissions (connect to each database and run):
\c libreviews_test
GRANT ALL ON SCHEMA public TO libreviews_user;
```

### 3. Install UUID Extensions

Install UUID generation extensions in the test database:

```sql
-- Connect to each database and install extensions
\c libreviews_test
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

**Note**: The fixture will attempt to enable extensions automatically, but may lack permissions on hosted services. Pre-installing them ensures tests run smoothly.

## Writing PostgreSQL Tests

1. **Use the shared setup helper**
   ```js
   import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

   const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
     tableSuffix: 'feature-under-test',
     cleanupTables: ['users', 'things']
   });
   ```

   The helper applies standard environment defaults, wires up `test.before/after`
   hooks, and provisions custom tables when `tableDefs` are supplied. Use
   `skipIfUnavailable(t)` in hooks or tests to bail out cleanly when PostgreSQL
   is not reachable.

2. **Models are loaded after bootstrap**
   ```js
   test.before(async t => {
     if (skipIfUnavailable(t)) return;

     const { User } = await dalFixture.initializeModels([
       { key: 'users', alias: 'User' }
     ]);
     // ...
   });
   ```

   The fixture configures table prefixes automatically; requesting the `users`
   model returns the version scoped to the worker schema (e.g.
   `test_testing_users`).

3. **Create test data using helpers**
   ```js
   // Use the fixture helper to create test users
   const { actor: testUser } = await dalFixture.createTestUser('Test User Name');
   ```

4. **Cleanup runs automatically**

   The setup helper truncates the tables listed in `cleanupTables` before each
   test and tears down connections (including dropping ad-hoc tables declared in
   `tableDefs`) after the suite finishes.

6. **Skip gracefully when PostgreSQL is unavailable**
   Wrap the setup in a `try/catch` and `t.pass()` with a message so local runs
   without PostgreSQL do not fail noisily.

## Running the Suite

```
npm run test-postgres
```

The command mirrors the RethinkDB runner: it compiles assets if needed, then
executes `ava` with the `tests-postgres/*-*.mjs` pattern while keeping the run
PostgreSQL-only (`LIBREVIEWS_SKIP_RETHINK=1` by default).

### Concurrency & teardown gotchas

- Test files share AVA workers; anything that touches the same tables needs either unique schema suffixes (`createDALFixtureAVA('slot', { tableSuffix: 'feature' })`) **or** to run serially (`test.serial`). Mixing parallel tests with shared fixture state is the fastest way to get intermittent “missing row” failures.
- The shared helper truncates registered tables automatically. If you opt out of `cleanupTables`, make sure to clear data manually; lingering rows or connections manifest as “Failed to exit” timeouts.
- If a suite performs asynchronous teardown beyond the fixture cleanup (e.g., awaiting mock servers), add a `test.after.always(async () => { await dalFixture.cleanup(); });` block to ensure the worker exits only after your teardown finishes.
- When stubbing modules such as `../search`, remember to delete them from `require.cache` in `after.always` so following tests see the real implementation.
- For PostgreSQL model tests that mutate shared tables (e.g. comprehensive integration suites), prefer serial tests (`test.serial(...)`) to avoid racing `cleanupTables()` calls across concurrent workers.
- Avoid reusing the same `tableSuffix` across different files; the fixture now derives schema names from the suffix, so it must be unique for genuine isolation.
