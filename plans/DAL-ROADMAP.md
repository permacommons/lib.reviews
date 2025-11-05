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

### Phase 3.5 – Type System Cleanup & Documentation (current)

Prepare the type system for Phase 4's registry-driven approach by addressing
immediate inconsistencies and documenting the target architecture.

**Immediate fixes:**
- Remove double export of `revision` object in `dal/lib/revision.ts` (both named
  and default export exist).
- Add TODO comments marking duplicate `ModelInstance` interface in `revision.ts`
  for consolidation in Phase 4.
- Document type safety issues in `model-types.ts` where generic type parameters
  are unused (prefixed with `_`), preventing proper type inference for model fields.

**Design documentation:**
- Document the distinction between base models and versioned models, clarifying
  that `hasRevisions` flag should drive type generation in Phase 4.
- Specify how the future registry should generate different instance types:
  - `ModelInstance<TRecord, TVirtual>` for base models
  - `VersionedModelInstance<TRecord, TVirtual>` for versioned models
- Outline the target type hierarchy where `ModelInstance` extends `TRecord & TVirtual`
  to provide proper type safety and autocomplete for model properties.
- Define proper option types (`SaveOptions`, `DeleteOptions`, `RevisionOptions`)
  to replace generic `JsonObject` parameters.

**Validation:**
- Audit all model files to ensure consistent use of `& Record<string, any>`
  workaround pattern (accepted short-term solution).
- Verify all models properly specify `hasRevisions` flag in initialization.
- Ensure revision-specific methods are only called on revisioned models.

**Outcomes:**
This phase creates a clear blueprint for Phase 4's type generation system while
maintaining stability. The current `ModelInstance` workarounds remain acceptable
until the registry can generate proper types automatically.

### Phase 4 – Declarative Model Registry & Typed Handles (next)

Replace manual model initialization with declarative manifests that drive type
generation. See `plans/PHASE-4-TYPE-SYSTEM.md` for detailed design.

**Goal:** Zero DAL exposure, full type safety, manifest as single source of truth.

**Example transformation:**
```typescript
// Before: manual types, explicit initialization
type UserInstance = ModelInstance<UserRecord, UserVirtual> & Record<string, any>;
const { model } = initializeModel({ dal, schema, ... });

// After: manifest-driven with inferred types
const manifest = { tableName: 'users', hasRevisions: true, schema: {...} } as const;
const User = createModel(manifest);
export default User;
// Usage: import User from './models/user'; (fully typed, no DAL visible)
```

**Infrastructure (additive, no breaking changes):**
- [ ] Add `VersionedModelInstance<TRecord, TVirtual>` interface to model-types.ts
- [ ] Add `VersionedModelConstructor<TRecord, TVirtual, TInstance>` to model-types.ts
- [ ] Create `dal/lib/model-manifest.ts` with manifest type and inference helpers
- [ ] Create `dal/lib/model-registry.ts` for global manifest storage
- [ ] Create `dal/lib/create-model.ts` that returns typed proxy from manifest
- [ ] Update `ModelInstance` to extend `TRecord & TVirtual` (with compatibility layer)

**Model migrations (each independent and deployable):**
- [ ] Migrate `team-slug.ts` to manifest format (proof of concept)
- [ ] Migrate `team-join-request.ts` to manifest format
- [ ] Migrate `invite-link.ts` to manifest format
- [ ] Migrate `thing-slug.ts` to manifest format
- [ ] Migrate `user-meta.ts` to manifest format
- [ ] Migrate `team.ts` to manifest format
- [ ] Migrate `user.ts` to manifest format
- [ ] Migrate `thing.ts` to manifest format
- [ ] Migrate `review.ts` to manifest format
- [ ] Convert `file.ts` to TypeScript + manifest format
- [ ] Convert `blog-post.ts` to TypeScript + manifest format

**Bootstrap & cleanup:**
- [ ] Update bootstrap to import models (auto-register) instead of explicit init
- [ ] Remove old `initializeModel` function from model-initializer.ts
- [ ] Remove duplicate `ModelInstance` interface from revision.ts
- [ ] Remove TODO comments added in Phase 3.5
- [ ] Verify all `& Record<string, any>` workarounds removed

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
