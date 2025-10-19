# PostgreSQL Test Harness

The files in this directory exercise the in-progress PostgreSQL DAL and models.  
They run independently from the legacy RethinkDB tests under `tests/` and use a
dedicated AVA wrapper (`npm run test-postgres`). Make sure the PostgreSQL
instance has the `pgcrypto` extension available so `gen_random_uuid()` defaults
work; the fixture will attempt to enable it but may lack permissions on hosted
services. The harness sets `LIBREVIEWS_SKIP_RETHINK=1`, so no RethinkDB
connections are opened while the Postgres suite runs.

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
