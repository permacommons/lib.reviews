# DAL Modernization Roadmap

This roadmap describes the migration from RethinkDB to PostgreSQL and the
target architecture for the Data Access Layer (DAL).

## Guiding Principles

- **Postgres first** – remove every RethinkDB dependency before investing in
  new backends or major refactors.
- **Ergonomic by default** – production code should continue to look like
  `const User = require(...); User.filterWhere({...})` with no DAL plumbing visible to
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

### Phase 4 – Declarative Model Registry, Typed Handles & Typed Filters

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
- ✅ Introduce a typed query helper (e.g. `filterWhere`, with helpers like `containsAll`, `containsAny`, `neq`) so modernised models can stop using the ReQL-style `filter(row => …)` proxy.
- ✅ Provide a `defineModel` helper that returns both the manifest constructor and the enriched static context, eliminating per-model cast boilerplate.
- ✅ Update the remaining models (thing, file, blog-post, etc.) to the same `defineModel` pattern used by `user`, removing legacy casts. As part of this, export canonical manifest-derived instance aliases (e.g. `UserInstance`, `ThingInstance`) for consumers that need explicit typings.
- ✅ Extend `filterWhere` operator helpers to cover range/negation/JSON use cases (for example `between`, `in`, `jsonContains`, `not`).
- ✅ Replace legacy Thinky-style `filter(row => …)` usage with first-class query-builder helpers building on `filterWhere`.
- ✅ Split manifest/type declarations from runtime implementations to eliminate circular lazy imports (`Thing`/`Review`, `Team`/`Review`) once consumers are on typed handles.

### Phase 5 – Increase typing surface; remove raw SQL

- **Harden the DAL typing surface**
  - ✅ Expose DAL helper namespaces (`mlString`, `revision`, `types`) with concrete typings so model modules can drop casts like `const { mlString } = dal as { ... }`. Cleaned up 14 files (11 manifests + 2 implementations + DAL core) to use `const { mlString, types } = dal;` pattern, eliminating all manual type casts.
  - [ ] Replace remaining `any` option bags in `create-model.ts` with the concrete types from `model-initializer.ts`, closing escape hatches around manifest initialisation.

- **Eliminate `Record<string, any>` fallbacks from hot paths**
  - [ ] Replace `Record<string, any>` fallbacks in core models (`review`, `thing`, `blog-post`, `team`, `file`) and their callers (`routes/things.ts`, `routes/uploads.ts`, action handlers) by threading manifest-derived types through statics/instance helpers and exposing typed payload shims where unavoidable.
  - [ ] Tighten `forms` key/value handling so attachment IDs arrive as clean `string[]`, matching typed query helper expectations, and cascade the stricter payloads into upload/action handlers.

- **Expand manifest-driven inference**
  - [ ] Derive relation result types directly from manifest relation metadata so models no longer need manual `types.virtual().returns<…>()` placeholders.
  - [ ] Thread manifest-derived instance types into `QueryBuilder` so `filterWhere().run()` returns e.g. `ThingInstance[]` without manual casts.
  - [ ] Make `filterWhere` operator helpers nullability-aware (e.g., only allow `neq(null)` on nullable fields) by threading schema-required flags into the operator typing.
  - [ ] Add explicit relation type maps to manifests—each manifest exports a `Relations` interface mapping relation names to target instance types. Use this to type helpers like `loadManyRelated<R extends keyof Relations>()` for full inference without code generation. Validate that relation names stay in sync via extracted literal types from the `relations` array.
  - [ ] Type-constrain relation names—extract relation names from manifest via `typeof manifest.relations[number]['name']` to constrain methods like `whereRelated()`, `orderByRelation()`, and `loadManyRelated()` to known relations, catching typos at compile time.
  - [ ] Explore relation-aware virtual field inference—investigate whether virtual fields for relations (`teams: TeamInstance[]`) can be derived from the relations array + type map, reducing manual `types.virtual().returns<...>()` declarations.

- **Clean up supporting infrastructure**
  - [ ] Refresh DAL fixtures/tests once the new helpers cover outstanding casts and remove lingering TODO breadcrumbs from earlier phases.
  - [ ] Audit remaining scattered raw SQL usage and design targeted query helpers that build on `filterWhere`.

### Phase 6 – Optional Backend Generalisation (future, only if needed)

- Define a capability contract if additional backends become a priority.
- Extract Postgres-specific helpers (for example, JSONB utilities) behind
  reusable abstractions.
- Explore lightweight secondary backends (for example, SQLite for tests) only
  if the primary Postgres path remains simple.
