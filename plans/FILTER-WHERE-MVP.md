# Typed `filterWhere` MVP

## Current Implementation Snapshot

The typed `filterWhere` API has landed and is available on every manifest-based model. The shared wiring lives in `dal/lib/filter-where.ts` and is injected automatically by `createModel`, so each model now exposes:

- `Model.filterWhere(literal)` – strongly typed entry point that replaces the untyped ReQL-style `filter` proxy for supported use cases.
- `Model.ops` – helper bag containing the currently implemented operators (`neq`, `contains`). Helpers can be referenced inside any predicate literal passed to `filterWhere`, `and`, or `or`.
- Default revision scoping – all filterWhere queries automatically scope to non-deleted, non-stale revisions until `.includeDeleted()` or `.includeStale()` opt out.
- Fluent query builder – the returned builder mirrors the existing query surface (`and`, `or`, `orderBy`, `limit`, `getJoin`, `whereIn`, `run`, `first`, etc.) while preserving typed results.

The initial rollout migrated the `Thing` maintenance script and the query-builder join tests to `filterWhere`, proving the pattern with revision-aware joins and helper usage.

## Capabilities & Limitations

- **Typed literals.** The first argument to `filterWhere` (and any chained predicate) must reference manifest-declared fields. TypeScript rejects unknown keys or mismatched value types.
- **Operator helpers.** `neq` works on any field. `contains` works on string-array-backed fields only and accepts a single element or an array. Additional helpers (`between`, `jsonContains`, etc.) are not implemented yet.
- **Helper reuse.** Call helper *functions* inline (destructure `const { neq } = Thing.ops` if helpful) but avoid storing helper *results* before attaching them to a field; doing so loses the key-specific typing and TypeScript can no longer warn about mismatches.
- **Logical combinators.** `and` mutates the underlying query; `or` builds grouped predicates. A dedicated `not` helper is not yet available.
- **Revision defaults.** `_old_rev_of IS NULL` and `_rev_deleted = false` are automatically applied unless explicitly disabled.
- **Fluent API parity.** Methods such as `includeSensitive`, `orderBy`, `limit`, `offset`, `getJoin`, `whereIn`, `run`, `first`, `count`, and deletion helpers behave identically to the legacy builder and preserve model instance typings.
- **Promise-like behaviour.** The builder implements `then/catch/finally`, enabling `await Model.filterWhere({ ... })` without extra `.run()` if desired.

## Adoption Guidelines

### When to Use `filterWhere`

- Equality or inequality-based predicates that only touch manifest-declared fields.
- Array membership checks on string-array columns that can be expressed with the provided `contains` helper.
- Queries that benefit from the automatic “current revision” guard (for example, fetching public-facing data).
- New code paths where typed results remove the need for manual `as ModelInstance` casts.

### How to Use It Today

1. Import the model and, if needed, destructure helpers from `Model.ops`:
   ```ts
   const { contains, neq } = Thing.ops;
   const results = await Thing.filterWhere({ id: targetId })
     .and({ urls: contains(targetUrls), createdBy: neq(blockedUser) })
     .orderBy('createdOn', 'DESC')
     .limit(25)
     .run();
   ```
2. Start with the broadest predicate in the initial literal, then chain additional literals via `.and()` or `.or()` as the query evolves.
3. Call `.includeDeleted()` or `.includeStale()` only when the caller truly needs those revisions; skipping the call keeps the default safety net.
4. Keep using downstream builder methods (joins, pagination, `whereIn`, etc.) exactly as before—the fluent API was preserved to ease adoption.

### When to Defer Back to `filter()`

Continue using the legacy `filter` proxy (or postpone migration) for call sites that require functionality we have not shipped yet:

- Predicates that rely on missing operators (`between`, `jsonContains`, `inArray`, deep JSON comparisons, negation, raw SQL fragments, etc.).
- Queries that depend on function-style filters (`row => row('urls').contains(...)`) instead of literal/object composition.
- Advanced boolean logic that requires `not`/`nor` style grouping beyond the current `and`/`or` support.
- Scenarios that need bespoke casting or type coercion not yet exposed through the `filterWhere` helpers.

Document these holdouts when you encounter them so we can prioritize the remaining helper work. Once the outstanding operators and logical helpers land, those `filter()` call sites should migrate to `filterWhere` to benefit from typing and shared revision defaults.
