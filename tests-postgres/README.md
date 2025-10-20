# PostgreSQL Test Harness

The files in this directory exercise the in-progress PostgreSQL DAL and models.  
They run independently from the legacy RethinkDB tests under `tests/` and use a
dedicated AVA wrapper (`npm run test-postgres`). The harness sets `LIBREVIEWS_SKIP_RETHINK=1`, so no RethinkDB
connections are opened while the Postgres suite runs.

## Database Setup Requirements

The PostgreSQL tests require proper database setup with appropriate permissions:

### 1. Create Test Databases

Create test databases for each AVA worker (tests run with concurrency: 4, plus extras for specific test suites):

```sql
CREATE DATABASE libreviews_test_1;
CREATE DATABASE libreviews_test_2;
CREATE DATABASE libreviews_test_3;
CREATE DATABASE libreviews_test_4;
CREATE DATABASE libreviews_test_5;
CREATE DATABASE libreviews_test_6;
```

**Note**: Each test file uses a specific `NODE_APP_INSTANCE` (e.g., `testing-1`, `testing-3`, etc.) which maps to these databases. The numbering ensures test isolation between concurrent AVA workers.

### 2. Grant Permissions

Grant full permissions to your PostgreSQL user (replace `libreviews_user` with your username):

```sql
-- Grant database-level permissions
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_1 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_2 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_3 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_4 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_5 TO libreviews_user;
GRANT ALL PRIVILEGES ON DATABASE libreviews_test_6 TO libreviews_user;

-- Grant schema-level permissions (connect to each database and run):
\c libreviews_test_1
GRANT ALL ON SCHEMA public TO libreviews_user;

\c libreviews_test_2
GRANT ALL ON SCHEMA public TO libreviews_user;

\c libreviews_test_3
GRANT ALL ON SCHEMA public TO libreviews_user;

\c libreviews_test_4
GRANT ALL ON SCHEMA public TO libreviews_user;

\c libreviews_test_5
GRANT ALL ON SCHEMA public TO libreviews_user;

\c libreviews_test_6
GRANT ALL ON SCHEMA public TO libreviews_user;
```

### 3. Install UUID Extensions

Install UUID generation extensions in each test database:

```sql
-- Connect to each database and install extensions
\c libreviews_test_1
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_2
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_3
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_4
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_5
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\c libreviews_test_6
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
```

**Note**: The fixture will attempt to enable extensions automatically, but may lack permissions on hosted services. Pre-installing them ensures tests run smoothly.

## Writing PostgreSQL Tests

1. **One fixture per file**
   ```js
   import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

   process.env.NODE_APP_INSTANCE = 'testing-X';
   const dalFixture = createDALFixtureAVA('testing-X');
   ```

2. **Bootstrap and create tables**
   ```js
   await dalFixture.bootstrap(); // establishes the pool
   await dalFixture.createTestTables([tableDefinition()]);
   ```

   Table helpers live in `./helpers/table-definitions.mjs`. Each helper builds
   a statement that the fixture rewrites with its test-specific prefix so
   parallel AVA workers never touch the same physical tables.

3. **Load real models**
   ```js
   const { users } = await dalFixture.initializeModels([
     { key: 'users', loader: dal => require('../models-postgres/user').initializeUserModel(dal) }
   ]);
   ```

   The fixture sets `dal.tablePrefix` before invoking initializers, so the model
   automatically binds to names like `test_testing_3_users`.

4. **Clean up aggressively**
   ```js
   test.beforeEach(() => dalFixture.cleanupTables(['users']));
   test.after.always(() => {
     await dalFixture.dropTestTables(['users']);
     await dalFixture.cleanup();
   });
   ```

5. **Skip gracefully when PostgreSQL is unavailable**
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

- Test files share AVA workers; anything that touches the same table names needs either unique prefixes (via `createDALFixtureAVA('slot', { tableSuffix: 'feature' })`) **or** to run serially (`test.serial`). Mixing parallel tests with shared fixture state is the fastest way to get intermittent “missing row” failures.
- Always call `dalFixture.cleanupTables()` in `beforeEach` and `dalFixture.dropTestTables()` + `dalFixture.cleanup()` in `after.always`; skipping even one cleanup leaves connections open and can block the AVA worker from exiting (manifests as “Failed to exit” timeouts).
- If a suite performs asynchronous teardown beyond the fixture cleanup (e.g., awaiting mock servers), register an AVA `registerCompletionHandler` so the worker exits only after your teardown finishes.
- When stubbing modules such as `../search`, remember to delete them from `require.cache` in `after.always` so following tests see the real implementation.
- For PostgreSQL model tests that mutate shared tables (e.g. comprehensive integration suites), prefer serial tests (`test.serial(...)`) to avoid racing `cleanupTables()` calls across concurrent workers.
- Avoid reusing the same `NODE_APP_INSTANCE` across different files unless every file uses a distinct `tableSuffix`; the fixture now derives prefixes from both pieces, so both must be unique for genuine isolation.
