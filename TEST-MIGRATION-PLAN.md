# RethinkDB to PostgreSQL Test Migration Plan

## 1. Overview

This document outlines a plan for migrating the remaining RethinkDB tests from the `tests/` directory to the new PostgreSQL test suite in `tests-postgres/`. The goal is to achieve full test coverage for the PostgreSQL data access layer (DAL) and eventually remove the dependency on RethinkDB.

## 2. Key Differences & Patterns

The analysis of the existing test suites reveals several key differences and patterns that will inform the migration process:

*   **Test Fixtures:** The RethinkDB tests use a monolithic `db-fixture.mjs`, while the PostgreSQL tests use a more modular `setup-postgres-test.mjs` helper that provides better test isolation through database schemas.
*   **Data Models:** The PostgreSQL models (`models-postgres/`) have been updated to use modern JavaScript features and are designed to work with the PostgreSQL DAL. Multilingual fields are now stored in JSONB columns, which is a significant change from the RethinkDB models.
*   **Test Structure:** The PostgreSQL tests are more granular, with separate files for different models and functionalities. This is a good practice that should be continued.
*   **Asynchronous Operations:** The PostgreSQL tests make extensive use of `async/await`, which should be the standard for all new tests.

## 3. Migration Strategy

The migration should be done on a file-by-file basis, starting with the tests that have the fewest dependencies. For each test file from the `tests/` directory, the following steps should be taken:

1.  **Create a new test file:** Create a new test file in the `tests-postgres/` directory with a descriptive name (e.g., `22-integration-signed-out.mjs`).
2.  **Set up the test fixture:** Use the `setupPostgresTest` helper to configure the test environment, specifying the necessary tables for cleanup.
3.  **Migrate the tests:** Rewrite the tests from the original RethinkDB test file to use the PostgreSQL models and DAL. This will involve:
    *   Replacing RethinkDB-specific queries with their PostgreSQL equivalents.
    *   Updating the test data to match the new model schemas (e.g., using JSONB for multilingual fields).
    *   Using the `dalFixture` to create test data and interact with the database.
4.  **Run the new tests:** Run the newly created test file to ensure that all tests pass.
5.  **Remove the old tests:** Once the new test file is complete and all tests are passing, the corresponding tests in the original RethinkDB test file should be removed.

## 4. Migration Checklist

The migration will be performed by creating new PostgreSQL-native test files and gradually porting over the legacy RethinkDB-era tests. This checklist tracks the work on a per-file basis.

### Core Integration Tests
- [ ] Migrate `tests/2-integration-signed-out.mjs` to `tests-postgres/22-integration-signed-out.mjs`
- [ ] Migrate `tests/3-integration-signed-in.mjs` to `tests-postgres/23-integration-signed-in.mjs`

### External Service and Adapter Tests
- [ ] Migrate `tests/4-adapters.mjs` to `tests-postgres/24-adapters.mjs`

### Application and Utility Tests
- [ ] Migrate `tests/5-markdown.mjs` to `tests-postgres/25-markdown.mjs`
- [ ] Migrate `tests/6-webhooks.mjs` to `tests-postgres/26-webhooks.mjs`
- [ ] Migrate `tests/7-autocomplete.mjs` to `tests-postgres/27-autocomplete.mjs`
- [ ] Migrate `tests/8-i18n-fallbacks.mjs` to `tests-postgres/28-i18n-fallbacks.mjs`
- [ ] Migrate `tests/9-flash-store.mjs` to `tests-postgres/29-flash-store.mjs`

## 5. Helper and Fixture Updates

The existing `setup-postgres-test.mjs` helper may need to be updated to support the new tests. For example, it may be necessary to add support for creating additional test data or for cleaning up additional tables.

## 7. Future Work

Once all of the RethinkDB tests have been migrated to PostgreSQL, the following future work will need to be done:

- The `tests/` directory will need to be removed from the repository.
- The RethinkDB-related dependencies will need to be removed from the `package.json` file.
- The configuration files for RethinkDB will need to be removed from the repository.

By following this plan, we can ensure a smooth and successful migration of the test suite from RethinkDB to PostgreSQL.
