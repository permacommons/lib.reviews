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

### Phase 1 – Finish the Postgres Cutover (current)

- ✅ Keep the Postgres DAL stable for routes already migrated.
- ✅ Document remaining RethinkDB hot spots so nothing is migrated blindly.
- 🔄 Remove any fresh regressions that make model imports harder to use.
- [ ] Fix all routes and functionality to work with Postgres DAL

### Phase 2 – Delete the RethinkDB Path

- [ ] Audit and remove code that still references `db-dual.js`, `db.js`, or legacy Thinky models.
- [ ] Migrate the last routes/workers/tests to Postgres equivalents with parity checks.
- [ ] Drop dual-database toggles, legacy models, and bridging logic once parity is verified.
- [ ] Update deployment docs to state Postgres-only support.

### Phase 3 – Centralised DAL Bootstrap & Ergonomics

- [ ] Introduce a single bootstrap (`bootstrap/dal.js`) that connects, migrates, and registers all models on startup.
- [ ] Make each `models-postgres/*.js` export a thin synchronous handle plus an `initializeModel(dal)` helper for fixtures.
- [ ] Ensure production code no longer calls `getPostgres*` helpers directly—everything comes from the bootstrap.
- [ ] Update fixtures to rely on the same factories while keeping the ergonomics invisible to application code.

### Phase 4 – Generalize DAL for Future Backends

- [ ] Optional: Define a backend capability contract if we ever add a secondary datastore.
- [ ] Optional: Extract Postgres-specific helpers (camelCase ↔ snake_case, JSONB utilities) into modules that another backend could reuse.
- [ ] Optional: Explore lightweight alternatives (e.g., SQLite for tests) only after the Postgres path is ergonomic and RethinkDB is gone.

## Open Questions / To-Do

- Where should the startup bootstrap live so both the web server and CLI workers share it cleanly?
- What’s the lightest-weight way to expose DAL access in request handlers (global singleton vs. dependency injection)?
- How do we keep fixture ergonomics while guaranteeing production never re-initializes models on demand?

Document updates belong in the repository alongside implementation PRs so the roadmap stays current. Feel free to expand with deeper design proposals, code sketches, or lessons learned as migration continues.
