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
- `createModel()` registers manifests globally, merges shared `filterWhere` statics, and returns a proxy constructor that delegates to lazily-initialised runtime models once bootstrap calls `initializeManifestModels()`.
- Schema builders derive persisted (`InferData`) and virtual (`InferVirtual`) field types; `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions` and layers in manifest-defined methods.
- Model instances intersect data/virtual fields with `ModelInstanceCore` for DAL helpers; an index signature remains for legacy compatibility but narrows via intersection (`dal/lib/model-types.ts`).
- `ModelConstructor` typing exposes CRUD, query, and helper statics. Revision-enabled constructors extend this with revision helpers.

## Query Builder & Filters
- Legacy `.filter(criteria)` accepts `unknown` and forwards to `QueryBuilder.filter`, preserving existing lambda/callback semantics with no typing guarantees (`dal/lib/model.ts`, `dal/lib/query-builder.ts`).
- `filterWhere` is the typed alternative injected into every manifest-derived constructor via `createFilterWhereStatics()` (`dal/lib/filter-where.ts`). Key behaviours:
  - Accepts typed literals keyed by manifest fields; values can be raw equality matches or operator helpers produced by `Model.ops`.
  - `FilterWhereBuilder` enforces default revision predicates (`_old_rev_of IS NULL`, `_rev_deleted = false`) unless `.includeStale()` / `.includeDeleted()` is invoked.
  - Methods mirror the legacy builder (joins, pagination, delete/count, `revisionData` scoping) and remain `PromiseLike` for ergonomic `await Model.filterWhere(...)` usage.
  - Operator coverage currently includes equality, inequality, numeric comparisons, and PostgreSQL array helpers (`@>`, `&&`) on string arrays. Boolean combinators are limited to `and`/`or`.
- Underlying `QueryBuilder` still builds SQL fragments manually. Typing is coarse (`JsonObject`) and direct column references rely on runtime `_resolveFieldName` mapping.

## Revision System
- `revision.ts` decorates versioned models with static/instance helpers (first revision creation, stale/deleted filters) and expects revision columns on the table.
- `filterWhere.revisionData()` exposes typed access to `_rev*` columns via the same operator helpers.

## Model Behaviours & Relations
- `model.ts` defines property accessors that translate camelCase to snake_case, handles validation/defaults via schema descriptors, and performs diffing (including deep equality for JSONB).
- Relations are normalised via `model-initializer.ts` but relation results are still surfaced through manually-declared virtual fields in manifests; inference of relation payload types is not automated.
- Model handles (`dal/lib/model-handle.ts`) provide lazy proxies for modules that need synchronous exports before bootstrap. `createAutoModelHandle` and `setBootstrapResolver` bridge runtime constructors.

## Observations & Gaps
- Many production modules still rely on `.filter()` with untyped predicates (`models/user.ts`, `routes/...`), so migration to `filterWhere` is incomplete.
- Operator helpers lack coverage for range/between, negation, `IN` lists, JSON containment, and other advanced predicates noted in `FILTER-WHERE-MVP.md`.
- Relation typings depend on manual `types.virtual().returns<...>()` declarations in manifests; there is no manifest-driven inference for relation payloads yet.
- Several helper types still expose broad `JsonObject` / `unknown` option bags (for example, `createModel` options) that could be narrowed per manifest.
