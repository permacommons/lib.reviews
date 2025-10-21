# DAL Modernization Roadmap

lib.reviews is in the middle of retiring its legacy RethinkDB stack in favor of a PostgreSQL-backed Data Access Layer (DAL). This document captures the target architecture and phased plan for the DAL so future contributors have a shared reference.

## Guiding Principles

- **Postgres first, RethinkDB last** – finish the migration by deleting every remaining RethinkDB dependency before we attempt bigger architectural moves.
- **Friendly ergonomics** – production code must keep the simple `const User = require(...); User.filter(...)` experience. DAL plumbing belongs behind the scenes.
- **Centralised bootstrap** – the app should initialise the database and models exactly once during startup; models shouldn’t re-run heavy setup when merely imported.
- **Lean model modules** – each model file should focus on schema and custom behaviour, not bespoke export boilerplate.
- **Fixture-aware tests** – test helpers can spin up isolated DAL instances, but that wiring should never leak into production code.

## Target Architecture (updated)

1. A single bootstrap module creates the DAL, runs migrations, and registers every model exactly once during application start-up.
2. Model modules export synchronous handles that proxy to the registered models, while also exposing a factory for fixtures (`initializeModel(dal)`).
3. Tests obtain models by calling the factory with their fixture DAL; production code keeps using the synchronous handle.
4. Once RethinkDB code is gone, revisiting multi-backend support becomes optional rather than a blocker.

## Roadmap Phases

### Phase 1 – Finish the Postgres Cutover

- ✅ Keep the Postgres DAL stable for routes already migrated.
- ✅ Document remaining RethinkDB hot spots so nothing is migrated blindly.
- ✅ Remove any fresh regressions that make model imports harder to use.
- [ ] Fix all routes and functionality to work with Postgres DAL

### Phase 2 – Delete the RethinkDB Path

- [ ] Audit and remove code that still references `db-dual.js`, `db.js`, or legacy Thinky models.
- [ ] Migrate the last routes/workers/tests to Postgres equivalents with parity checks.
- [ ] Drop dual-database toggles, legacy models, and bridging logic once parity is verified.
- [ ] Update deployment docs to state Postgres-only support.

### Phase 3 – Centralised DAL Bootstrap & Ergonomics

- ✅ Introduce a single bootstrap (`bootstrap/dal.js`) that connects, migrates, and registers all models on startup.
- ✅ Make each `models-postgres/*.js` export a thin synchronous handle plus an `initializeModel(dal)` helper for fixtures.
- ✅ Ensure production code no longer calls `getPostgres*` helpers directly—everything comes from the bootstrap.
- ✅ Update fixtures to rely on the same factories while keeping the ergonomics invisible to application code.

### Phase 4 – Generalize DAL for Future Backends

- [ ] Optional: Define a backend capability contract if we ever add a secondary datastore.
- [ ] Optional: Extract Postgres-specific helpers (camelCase ↔ snake_case, JSONB utilities) into modules that another backend could reuse.
- [ ] Optional: Explore lightweight alternatives (e.g., SQLite for tests) only after the Postgres path is ergonomic and RethinkDB is gone.

## Open Questions / To-Do

- Where should the startup bootstrap live so both the web server and CLI workers share it cleanly?
- What’s the lightest-weight way to expose DAL access in request handlers (global singleton vs. dependency injection)?
- How do we keep fixture ergonomics while guaranteeing production never re-initializes models on demand?

Document updates belong in the repository alongside implementation PRs so the roadmap stays current. Feel free to expand with deeper design proposals, code sketches, or lessons learned as migration continues.

## Phase 3 Implementation Notes

**Completed (December 2024):**

The centralized bootstrap system has been implemented with the following key components:

1. **`bootstrap/dal.js`** - Single initialization point that:
   - Creates and connects the DAL instance
   - Runs database migrations
   - Registers all models exactly once
   - Provides clean shutdown functionality
   - Supports isolated test DAL creation

2. **Model Synchronous Handles** - Each model now exports:
   - A synchronous handle that proxies to registered models
   - An `initializeModel(dal)` factory for fixtures and tests
   - Backward compatibility with existing `getPostgres*Model` functions

3. **Application Integration** - Updated `app.js` to:
   - Use the bootstrap system instead of direct `db-postgres` imports
   - Initialize all models during startup
   - Eliminate double-initialization issues

**Key Benefits Achieved:**
- ✅ Single source of truth for DAL initialization
- ✅ Eliminated double-initialization problems
- ✅ Clean separation between production and test environments
- ✅ Maintained existing model API compatibility
- ✅ Centralized model registration and lifecycle management
- ✅ `dal/lib/model-factory.js` ensures model factories reuse the DAL-registered instance, keeping slug helpers and other factories from re-running `createModel`
- ✅ **Self-aware model handles** - Eliminated 50+ lines of boilerplate per model using Proxy API
- ✅ **Automatic method detection** - Models automatically proxy all methods to registered instances
- ✅ **Graceful degradation** - Handles work even when DAL isn't initialized yet

**Resolved Questions:**
- ✅ ~~Where should the startup bootstrap live so both the web server and CLI workers share it cleanly?~~ **Resolved:** `bootstrap/dal.js` provides shared initialization for all contexts.
- ✅ ~~What's the lightest-weight way to expose DAL access in request handlers (global singleton vs. dependency injection)?~~ **Resolved:** Synchronous model handles provide clean access without explicit DAL passing.
- ✅ ~~How do we keep fixture ergonomics while guaranteeing production never re-initializes models on demand?~~ **Resolved:** Separate `initializeModel()` factories for tests, synchronous handles for production.

## Phase 3.5 – DAL Ergonomics & Test Harness (proposed)

Before we jump to backend generalisation, we should harden the current PostgreSQL path.
Focus for the next iteration:

1. **Model Registry class** – wrap registration/lookup in a dedicated object so models register exactly once, duplicate registration throws immediately, and table-prefix handling lives in one place instead of ad-hoc maps.
2. **Documented contracts** – add JSDoc (or TypeScript) typedefs for `DataAccessLayer`, `Model`, `QueryBuilder`, and the factory helpers so contributors have authoritative signatures without spelunking internals.
3. **Test DAL harness (death to `customDAL`)** – build a dedicated fixture that bootstraps an isolated DAL, calls the registry to load models, and hands tests scoped helpers. Models no longer need `customDAL` branches; production keeps its singleton.

These improvements keep the bootstrap-as-singleton design, but make the code easier to reason about and safer to extend.
## 
Model Handle Factory Implementation

**Added (December 2024):**

Created `dal/lib/model-handle.js` with intelligent proxy-based handles that eliminate boilerplate:

**Before (per model):**
```javascript
const UserHandle = {
  filter(...args) {
    const { getModel } = require('../bootstrap/dal');
    const model = getModel('users') || User;
    if (!model) throw new Error('User model not registered');
    return model.filter(...args);
  },
  // ... 10+ more methods with identical boilerplate
};
```

**After (per model):**
```javascript
const { createAutoModelHandle } = require('../dal/lib/model-handle');
const UserHandle = createAutoModelHandle('users', initializeUserModel, {
  staticProperties: { options: userOptions }
});
```

**Key Features:**
- **Automatic Proxying**: Uses JavaScript Proxy API to forward all method calls
- **Self-Discovery**: Automatically detects and proxies any method on the registered model
- **Static Properties**: Supports static properties like `User.options`
- **Factory Integration**: Seamlessly exposes `initializeModel` for test fixtures
- **Error Handling**: Provides clear error messages when models aren't registered
- **Graceful Degradation**: Works even during startup before DAL initialization
