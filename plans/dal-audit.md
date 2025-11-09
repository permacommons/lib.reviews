# DAL Architecture Audit

## Overview
- Source of truth lives in `dal/lib/` with models declared in `models/`.
- DAL exports `createDataAccessLayer` (`dal/index.ts`) which wraps `DataAccessLayer` and surfaces helper namespaces (`Model`, `QueryBuilder`, `types`, `Errors`, `mlString`, `revision`).
- Runtime DAL instances own a `ModelRegistry` that maps table names/keys to constructors (`dal/lib/data-access-layer.ts`, `dal/lib/model-registry.ts`).

## Connection & Lifecycle
- `DataAccessLayer` manages a shared `pg.Pool`, connection testing, transactions, and migrations (`dal/lib/data-access-layer.ts`).
- Registries are cleared on `disconnect()` to avoid leaking constructors between DAL instances (important for tests).
- Migrations run SQL files from `migrations/`, track executed files in a `migrations` table, and run inside transactions.

## Model Bootstrapping & Typing
- Declarative manifests (`defineModelManifest` / `defineModel`) describe schema, relations, revision support, and custom methods (`dal/lib/create-model.ts`, `dal/lib/model-manifest.ts`).
- `createModel()` registers manifests globally, merges shared `filterWhere` statics, and returns a proxy constructor that delegates to lazily initialised runtime models once bootstrap calls `initializeManifestModels()`.
- `defineModel()` wraps `createModel()` so model modules can add bespoke statics without casts while preserving manifest inference (`dal/lib/create-model.ts`).
- Schema builders derive persisted (`InferData`) and virtual (`InferVirtual`) field types; `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions` and layers in manifest-defined methods.
- Model instances intersect data/virtual fields with `ModelInstanceCore` for DAL helpers; an index signature remains for legacy compatibility but narrows via intersection (`dal/lib/model-types.ts`).
- `ModelConstructor` typing exposes CRUD, query, and helper statics. Revision-enabled constructors extend this with revision helpers.

## Query Builder & Filters
- `filterWhere` is the typed entry point injected into every manifest-derived constructor via `createFilterWhereStatics()` (`dal/lib/filter-where.ts`). Key behaviours:
  - Accepts typed literals keyed by manifest fields; values can be raw equality matches or operator helpers produced by `Model.ops`.
  - Operator helpers now span inequality, range, membership, boolean negation, array overlap, and JSON containment use cases (`lt`/`lte`/`gt`/`gte`, `between`/`notBetween`, `in`, `containsAll`/`containsAny`, `not`, `jsonContains`).
  - `FilterWhereBuilder` enforces default revision predicates (`_old_rev_of IS NULL`, `_rev_deleted = false`) unless `.includeStale()` / `.includeDeleted()` is invoked and supports joins/order/limit helpers.
  - Methods are `PromiseLike` for ergonomic `await Model.filterWhere(...)` usage.
- Underlying `QueryBuilder` still builds SQL fragments manually. Typing is coarse (`JsonObject`) and direct column references rely on runtime `_resolveFieldName` mapping.

## Revision System
- `revision.ts` decorates versioned models with static/instance helpers (first revision creation, stale/deleted filters) and expects revision columns on the table.
- `filterWhere.revisionData()` exposes typed access to `_rev*` columns via the same operator helpers.

## Model Behaviours & Relations
- `model.ts` defines property accessors that translate camelCase to snake_case, handles validation/defaults via schema descriptors, and performs diffing (including deep equality for JSONB).
- Relations are normalised via `model-initializer.ts` but relation results are still surfaced through manually-declared virtual fields in manifests; inference of relation payload types is not automated.
- Model handles (`dal/lib/model-handle.ts`) provide lazy proxies for modules that need synchronous exports before bootstrap. `createAutoModelHandle` and `setBootstrapResolver` bridge runtime constructors.

## Observations & Gaps
- Relation typings depend on manual `types.virtual().returns<...>()` declarations in manifests; there is no manifest-driven inference for relation payloads yet (`models/user.ts`, `models/blog-post.ts`).
- Several helper types still expose broad `JsonObject` / `unknown` option bags (for example, `createModel` options) that could be narrowed per manifest (`dal/lib/create-model.ts`, `dal/lib/model-initializer.ts`).
- Core models with complex behaviours (`models/review.ts`, `models/thing.ts`, `models/blog-post.ts`) still fall back to `Record<string, any>` in statics and instance helpers, forcing consumers such as `routes/things.ts` and `routes/uploads.ts` to lean on `any`-centric payload shims.
- Route helpers like `routes/helpers/forms.ts` continue to emit `Record<string, any>` structures, complicating plans to make form payloads align with typed model inputs.
- Raw SQL remains embedded in several model statics (for example `models/blog-post.ts#getMostRecentBlogPosts`), indicating future helper work for common query patterns.
