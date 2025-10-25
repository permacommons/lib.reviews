# Test Performance Hypotheses

This document outlines potential causes for the performance regression in the `npm run test-postgres` command.

## Hypotheses Checklist

- [x] **Incorrect Database Configuration:** The test suite was not loading the `testing` configuration, causing it to run against the wrong database. **Status:** Fixed. Adding `NODE_APP_INSTANCE=testing` to the test runner script resolved the test failures.
- [x] **Inefficient Test Teardown:** The process of cleaning up the test database after each test file was inefficient and prone to race conditions. **Status:** Resolved. The root cause was a combination of factors.
- [x] **Connection Pool Exhaustion / Premature Closing:** Per-file cleanup hooks were closing the connection pool prematurely, causing race conditions. **Status:** Fixed by centralizing cleanup.
- [ ] **Inefficient Test Queries:** This was not a primary cause of the regression.

## Investigation Log

*   **Initial Run (2025-10-24):** `time npm run test-postgres` took `1m36.007s` and produced 6 test failures due to missing `NODE_APP_INSTANCE=testing`.
*   **Second Run (2025-10-24):** Added `NODE_APP_INSTANCE=testing` to the test runner's child process. `time npm run test-postgres` took `1m32.836s`. All tests passed, but the slow teardown and "pool has ended" errors pointed to a race condition in the cleanup logic.
*   **Third Run (2025-10-24):** Identified that `test.after.always` in each test file was causing concurrent cleanup operations to interfere with each other. Removed the per-file cleanup and implemented a centralized cleanup hook in the main test runner.
*   **Fourth Run (2025-10-24):** The centralized cleanup using the full test harness was still slow (`~1m34s`), indicating the cleanup process itself was the bottleneck.
*   **Final Run (2025-10-24):** Replaced the heavyweight test harness in the cleanup hook with a direct, lightweight `pg` client connection. **This resolved the performance regression**, bringing the test execution time down to `~29s`. The teardown process is now fast and efficient.
