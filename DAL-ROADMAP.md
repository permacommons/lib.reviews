# DAL Modernization Roadmap

We are finishing the migration from the legacy RethinkDB stack to a PostgreSQL
Data Access Layer (DAL). This roadmap describes the target architecture, the
remaining phases, and the clean‑up items that keep the current DAL pleasant to
work with.

## Guiding Principles

- **Postgres first** – remove every RethinkDB dependency before investing in
  new backends or major refactors.
- **Ergonomic by default** – production code should continue to look like
  `const User = require(...); User.filter(...)` with no DAL plumbing visible to
  route handlers.
- **Single bootstrap** – the application initialises the DAL once, at startup;
  models are registered exactly one time per DAL instance.
- **Lean model modules** – model files define schema plus behaviour. They
  should not open connections, run migrations, or contain bespoke export
  wrappers.
- **Test isolation without pollution** – fixtures may create isolated DALs, but
  that wiring must remain outside production paths.

## Current Architecture Snapshot

- `bootstrap/dal.js` owns connection setup, migrations, model registration, and
  shutdown.
- Models export synchronous handles backed by the registered model plus an
  `initializeModel(dal)` helper for fixtures.
- `dal/lib/model-factory.js` ensures every initializer reuses an existing model
  when the DAL already knows about the table, preventing duplicate
  registrations.

This baseline is in place; the remaining work focuses on completing feature
coverage and tightening ergonomics.

## Roadmap Phases

### Phase 1 – Finish the PostgreSQL Cutover

- ✅ Keep migrated routes stable under the Postgres DAL.
- ✅ Document RethinkDB holdouts so migration work is planned rather than ad
  hoc.
- ✅ Eliminate regressions that make model imports harder to use.
- ☐ Fix the remaining routes, jobs, and helpers that still fail under the
  Postgres DAL.

### Phase 2 – Remove the RethinkDB Path

- ☐ Delete code that references `db-dual.js`, `db.js`, and Thinky models.
- ☐ Port the final routes/workers/tests to Postgres and verify behaviour.
- ☐ Drop dual-database toggles, bridges, and config once parity is confirmed.
- ☐ Update deployment/runtime docs for Postgres-only operation.

### Phase 3 – Bootstrap & Model Ergonomics (completed)

- ✅ Single bootstrap initialises the DAL and registers models exactly once.
- ✅ Model modules export synchronous handles plus fixture factories.
- ✅ Tests rely on explicit factories rather than ad hoc global state.
- ✅ `getOrCreateModel` prevents duplicate registrations across production and
     test DALs.

### Phase 3.5 – DAL Ergonomics & Test Harness (planned)

1. **Model registry** – encapsulate registration/lookup and enforce one-time
   registration per DAL instance.
2. **Documented contracts** – publish JSDoc or TypeScript definitions for core
   DAL interfaces (`DataAccessLayer`, `Model`, `QueryBuilder`, helpers).
3. **Dedicated test harness** – provide a fixture that spins up an isolated DAL
   via the bootstrap, allowing model files to drop `customDAL` branches.
4. **Constructor ergonomics** – ensure passing an object into `new Model({...})`
   automatically routes through accessors so `_changed` is tracked without
   manual reassignments.

### Phase 4 – Optional Backend Generalisation

- Define a capability contract if additional backends ever matter.
- Extract Postgres-specific helpers (e.g., JSONB utilities) behind reusable
  abstractions.
- Explore lightweight secondary backends (e.g., SQLite for tests) only if the
  primary Postgres path remains simple.

## Open Questions

- Which pieces of the public DAL API need documentation or typing to reduce
  onboarding friction?
- What is the minimum surface area a future model registry should expose
  (lookup, list, metrics, etc.)?
- How do we package the forthcoming test harness so CLI tools, scripts, and
  AVA fixtures can share it without leaking into production code?

Keep this document up to date when phases progress or priorities shift.
