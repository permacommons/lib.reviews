# DAL Modernization Roadmap

lib.reviews is in the middle of retiring its legacy RethinkDB stack in favor of a PostgreSQL-backed Data Access Layer (DAL). This document captures the target architecture and phased plan for the DAL so future contributors have a shared reference.

## Guiding Principles

- **Single source of truth** – treat the DAL as the authoritative interface to persistence; app code should never couple directly to a specific backend.
- **Stateless factories** – model factories must be pure functions that accept a DAL instance and return a model bound to that instance; avoid module-level singletons.
- **Explicit lifetimes** – the DAL owns its models (e.g., `dal.getModel('user')`) so request handlers can safely access backend-specific functionality without racing reinitialization.
- **Backend portability** – the DAL interface needs well-defined capabilities (query builder, migrations, UUID generation, transactions) so future backends can swap in by implementing the same contract.
- **Test ergonomics** – tests instantiate their own DAL instance (fixtures or in-memory backends) using the same factory path as production code—no special-case branches.

## Target Architecture

1. `createDAL(config)` returns a DAL instance that exposes:
   - Connection lifecycle (`connect`, `disconnect`, `migrate`).
   - Query builder / raw query helpers.
   - Model registry (`dal.models.user` or `dal.getModel('user')`).
   - Capability hooks (e.g., `dal.generateUUID()`).
2. Model modules export pure factories, e.g.:

   ```js
   // models-postgres/user.js
   module.exports = function createUserModel(dal) { ... }
   ```

   The factory builds schema definitions, registers field mappings, and returns the model bound to the injected DAL without mutating module-level state.

3. Application code receives a DAL instance via an initialization step (or per-request context) and pulls models from it. This eliminates the need for global singletons and makes multi-backend support explicit.

## Roadmap Phases

### Phase 1 – Stabilize Postgres DAL (current)

- ✅ Ensure all routes that are already migrated to PostgreSQL use the new DAL without crashing on repeat initialization (e.g., invite flow fixes).
- ✅ Remove eager attempts to reinitialize models with different DAL instances from within application code.
- 🔄 Document and ticket any remaining hotspots where routes still require legacy Thinky models.

### Phase 2 – Remove Dual Setup & Legacy Models

- [ ] Audit all code paths still touching `db-dual.js`, `db.js`, and `models/` (Thinky). Track remaining features that depend on RethinkDB.
- [ ] Migrate outstanding routes and workers to PostgreSQL equivalents, ensuring parity through tests and/or fixtures.
- [ ] Delete dual-database toggles, the legacy RethinkDB models, and the bridging code once all features are confirmed on Postgres.
- [ ] Update ops/docs/scripts to reflect a single-database deployment story (Postgres only).

### Phase 3 – Introduce DAL Factory Pattern

- [ ] Refactor each `models-postgres/*.js` module into a stateless factory (no shared globals).
- [ ] Implement a DAL model registry to cache factories per DAL instance (`dal.models.user`, etc.).
- [ ] Update route, worker, and CLI entry points to receive a DAL instance (e.g., through dependency injection or a bootstrap module) instead of requiring models directly.
- [ ] Adjust test fixtures to construct DAL instances via the same entry point, removing custom “inject DAL” pathways.

### Phase 4 – Generalize DAL for Future Backends

- [ ] Define a backend capability contract (query interface, migrations, UUID generator, transaction semantics).
- [ ] Formalize helper APIs that model factories can rely on (e.g., `dal.uuid.v4()`) so backend differences are abstracted through the DAL.
- [ ] Extract Postgres-specific logic (camelCase ↔ snake_case mappings, JSONB helpers) into pluggable adapters where it improves clarity.
- [ ] Evaluate potential secondary backends (SQLite for testing, read-only replicas, etc.) to validate the abstraction.

## Open Questions / To-Do

- How should request-scoped DAL instances be surfaced (Express middleware vs. global service container)?
- What metrics/logging hooks should the DAL expose to standardize monitoring across backends?
- Do we need migration tooling that understands multiple backends (e.g., Prisma-style providers) or is SQL migration per backend sufficient?

Document updates belong in the repository alongside implementation PRs so the roadmap stays current. Feel free to expand with deeper design proposals, code sketches, or lessons learned as migration continues.

