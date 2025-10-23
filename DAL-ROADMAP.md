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

### Phase 4 – Optional Backend Generalisation

- Define a capability contract if additional backends ever matter.
- Extract Postgres-specific helpers (e.g., JSONB utilities) behind reusable
  abstractions.
- Explore lightweight secondary backends (e.g., SQLite for tests) only if the
  primary Postgres path remains simple.