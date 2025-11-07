# Typed `filterWhere` MVP

## Summary

Introduce a typed `filterWhere` API for manifest-driven models that replaces the legacy `filter` proxy, keeps object-literal ergonomics, and produces fully typed query builders. The initial rollout targets the `Thing` model but the implementation must be generic so every manifest model can adopt it with minimal work.

## Goals

- **Typed equality filters** – `Model.filterWhere({ field: value })` is the default entry point. Field names must exist on the manifest-derived record/virtual types; values are type-checked against those definitions.
- **Revision defaults** – Queries automatically scope to current, non-deleted revisions. Callers explicitly opt out via fluent methods (for example, `.includeDeleted()`, `.includeStale()`).
- **Operator helpers** – Each model exposes a typed helper bag (`Model.ops`). Helpers such as `contains`, `inArray`, `between`, `neq`, and `jsonContains` can be used anywhere a value is accepted: in the initial literal or in chained predicates.
- **Fluent composition** – `filterWhere` returns a typed query builder that supports `and`, `or`, `not`, `includeDeleted`, `includeStale`, `getJoin`, `orderBy`, `limit`, `whereIn`, `run`, `first`, etc. Additional predicates are composed via chaining rather than extra parameters.
- **Typed results** – The builder resolves to `Promise<ModelInstance[]>` (and `ModelInstance | undefined` for `first()`), eliminating downstream `as Record<string, any>` casts. Relation joins refine the return type to include joined instances.
- **Generic infrastructure** – Core logic (builder, helper descriptors, model bindings) lives alongside the manifest utilities so every model can expose `filterWhere`/`ops` consistently. `Thing` is the MVP adopter; other models only need lightweight wiring once the shared pieces land.

## Non-Goals for the MVP

- Deep JSON-path typing beyond the manifest’s existing record/virtual metadata.
- Removing the legacy `filter` implementation immediately (it can coexist during migration).
- Raw SQL predicate escapes; these can follow later if needed.

## API Overview

```ts
const { contains, inArray, between, jsonContains, neq } = Thing.ops;

const things = await Thing.filterWhere({
  canonicalSlugName: slugParam,
  urls: contains(primaryUrls),
  createdBy: neq(blockedUser),
})
  .or({ metadata: jsonContains({ category: 'news' }) })
  .and({ createdOn: between(start, end) })
  .includeStale()
  .orderBy('createdOn', 'DESC')
  .limit(25)
  .run();
```

- **Literal first argument:** mandatory `Partial<Record & Virtual>`. Unknown keys or mismatched value types fail compilation.
- **Helpers everywhere:** operator helpers from `Model.ops` may be used directly inside any predicate literal (base call or chained `and`/`or`/`not`).
- **Chaining:** `and`, `or`, and `not` accept the same typed literal shape. They only execute when explicitly chained, keeping the simple cases trivial.
- **Revision scope:** `includeDeleted()` removes the implicit `_rev_deleted IS NOT TRUE` constraint; `includeStale()` removes `_old_rev_of IS NULL`. (Names can be adjusted but the semantics are fixed.)

## Acceptance Criteria

1. `Model.filterWhere` enforces manifest-derived field names and value types at compile time.
2. `Model.ops` exposes typed helpers usable in any predicate literal; invalid combinations (for example, calling `contains` on a non-array field) fail compilation.
3. The builder applies “current, not deleted” filters by default and provides chainable opt-outs (`includeDeleted`, `includeStale`). Unit tests cover combinations.
4. Logical combinators (`and`, `or`, `not`) accept typed literals and correctly compose SQL predicates; tests cover conjunction, disjunction, and negation.
5. The builder returned by `filterWhere` supports the existing fluent query methods (`getJoin`, `whereIn`, `orderBy`, `limit`, `run`, `first`, etc.) with result types narrowing to the model’s instance (and joined relations when applicable).
6. `Thing` migrates to the new API (covering existing usages such as `maintenance/generate-thing-slugs.ts` and `tests/16-query-builder-joins.ts`) without behavioral regressions, demonstrating MVP readiness.
7. Documentation in this file outlines how other models adopt the shared implementation (for example, exporting `filterWhere`/`ops` from `createModel` outputs) to avoid per-model bespoke wiring.

## Rollout Notes

1. Land the shared infrastructure (typed predicate descriptors, builder enhancements, helper generation) in the DAL/lib layer.
2. Wire the `Thing` model to expose `filterWhere` and `ops`, migrate its call sites, and add regression tests.
3. Once validated, document the adoption checklist for other models (import helper mixin, expose `filterWhere`, update call sites). Full rollout can proceed in parallel tasks.
