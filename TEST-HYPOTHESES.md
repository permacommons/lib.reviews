# Test Performance Hypotheses

This document tracks hypotheses for the PostgreSQL test suite performance regression.

## Baseline Performance

- **Initial:** ~30 seconds
- **Current:** ~96 seconds

## Hypotheses Checklist

- [ ] **Inefficient Teardown:** The test teardown process is slow. The multiple "Failed to truncate tables" warnings suggest that the cleanup logic is attempting to truncate tables that don't exist, or that the order of operations is incorrect. This could be causing delays as the database waits for timeouts or retries.
- [ ] **Schema Dropping:** The move to a single test database with schemas for isolation might be the culprit. Instead of efficiently dropping the entire schema at once, the teardown process might be iterating through tables, causing the slowdown.
- [ ] **Configuration Issues:** The `NODE_APP_INSTANCE` warnings indicate that the test-specific configuration is not being loaded correctly. This could lead to suboptimal database connection setting or other performance-related issues.
- [ ] **Connection Pooling:** The "Cannot use a pool after calling end on the pool" warning suggests that the database connection pool is being closed prematurely, before all cleanup operations are complete. This could be causing timeouts and retries.
