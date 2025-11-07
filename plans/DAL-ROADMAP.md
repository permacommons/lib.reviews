# DAL Modernization Roadmap

This roadmap describes the migration from RethinkDB to PostgreSQL and the
target architecture for the Data Access Layer (DAL).

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

### Phase 1 – Finish the PostgreSQL Cutover ✅ COMPLETE

- ✅ Keep migrated routes stable under the Postgres DAL.
- ✅ Document RethinkDB holdouts so migration work is planned rather than ad hoc.
- ✅ Eliminate regressions that make model imports harder to use.
- ✅ Fix the remaining routes, jobs, and helpers that still fail under the Postgres DAL.
- ✅ Remove `models-legacy/` directory.

### Phase 2 – Remove the RethinkDB Path ✅ COMPLETE

- ✅ Delete `models-legacy/` directory and legacy model code.
- ✅ Update documentation to reflect PostgreSQL-only operation.
- ✅ Remove RethinkDB-specific files:
  - `db.js` (RethinkDB connection)
  - `orm/` directory (Thinky wrapper)
  - `migrations/` directory (RethinkDB migration scripts)
  - RethinkDB npm dependencies
  - RethinkDB config settings

### Phase 3 – Bootstrap & Model Ergonomics ✅ COMPLETE

- ✅ Single bootstrap initialises the DAL and registers models exactly once.
- ✅ Model modules export synchronous handles plus fixture factories.
- ✅ Tests rely on explicit factories rather than ad hoc global state.
- ✅ `getOrCreateModel` prevents duplicate registrations across production and
     test DALs.

### Phase 4 – Declarative Model Registry & Typed Handles (current)

Replace manual model initialization with declarative manifests that drive type generation. See `plans/PHASE-4-TYPE-SYSTEM.md` for detailed design.

**Goal:** Zero DAL exposure, full type safety, manifest as single source of truth.

**Completed milestones**
- ✅ Added `VersionedModelInstance`/`VersionedModelConstructor` to the shared type definitions.
- ✅ Introduced manifest inference helpers and the global registry.
- ✅ Implemented `create-model.ts` so manifests return typed proxies.
- ✅ Updated `ModelInstance` to merge record/virtual fields inferred from the schema builders.
- ✅ Migrated every model (team, user, thing, review, file, blog-post, etc.) to the manifest format.
- ✅ Applied contextual `ThisType` so manifest static/instance methods receive strongly typed `this`.
- ✅ Updated bootstrap to register models simply by importing them.

**Next steps (in order)**
- ✅ Introduce a typed query helper (e.g. `filterWhere`, with helpers like `contains`, `neq`) so modernised models can stop using the ReQL-style `filter(row => …)` proxy.
- [ ] Provide a `defineModel` helper that returns both the manifest constructor and the enriched static context, eliminating per-model cast boilerplate.
- [ ] Update the remaining models (file, blog-post, etc.) to the same constructor pattern used by `user`/`thing` once the typed query helper exists, removing legacy casts.
- [ ] Export canonical manifest-derived instance aliases (e.g. `UserInstance`, `ThingInstance`) for consumers that need explicit typings.
- [ ] Reshape consumer modules (auth flow, actions, blog-post, thing routes) to rely on the typed constructors instead of local `Record<string, any>` placeholders.
- [ ] After `filterWhere` lands, migrate call sites off the proxy and remove temporary shims such as `ThingPayload`/`as any`.
- [ ] Tighten `forms` key/value handling so attachment IDs arrive as clean `string[]`, matching typed query helper expectations.
- [ ] Replace remaining `any` option bags in `create-model.ts` with the concrete types from `model-initializer.ts`.
- [ ] Refresh DAL fixtures/tests once the new helpers cover outstanding casts and remove lingering TODO breadcrumbs from earlier phases.

### Phase 5 – Optional Backend Generalisation (future, only if needed)

- Define a capability contract if additional backends become a priority.
- Extract Postgres-specific helpers (for example, JSONB utilities) behind
  reusable abstractions.
- Explore lightweight secondary backends (for example, SQLite for tests) only
  if the primary Postgres path remains simple.

## Outstanding Ergonomic Follow-ups

- Replace legacy Thinky-style `filter(row => …)` usage with first-class
  query-builder helpers (for example, `whereArrayOverlap`, `whereNotId`) so we
  can drop the proxy/function parser and rely on declarative predicates only.
- Introduce high-level conveniences for common lookups (for example,
  `Thing.lookupByURLs(urls, { excludeId })`) to consolidate duplication checks
  into one SQL call instead of scattering per-URL queries across routes.
- Align fixtures with the model registry so seeded test data uses the same typed
  constructors, paving the road for the optional backend generalisation phase.
