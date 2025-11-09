# PostgreSQL Data Access Layer

The lib.reviews DAL is a TypeScript-first PostgreSQL abstraction that exposes typed model constructors, revision helpers, and a fluent query builder. Application code imports models synchronously while bootstrap wires them to a live `pg` connection exactly once.

## Core Building Blocks

- **DataAccessLayer (`dal/lib/data-access-layer.ts`)** – Owns the shared `pg.Pool`, manages migrations, and keeps a per-instance `ModelRegistry` so constructors are isolated between DALs (useful for fixtures/tests).
- **Model runtime (`dal/lib/model.ts`)** – Implements camelCase ↔︎ snake_case mapping, validation/default handling, change tracking, and persistence primitives consumed by every manifest-driven model.
- **Manifest system (`dal/lib/create-model.ts`, `dal/lib/model-manifest.ts`)** – Declarative manifests define schema, relations, revision support, and custom methods. `defineModel` returns a lazy proxy constructor whose types are inferred from the manifest.
- **Query builder (`dal/lib/query-builder.ts`)** – Builds SQL fragments for filters, joins, ordering, pagination, and deletes. `filterWhere` wraps it with typed predicates, while the legacy `.filter()` path remains for holdouts.
- **Revision helpers (`dal/lib/revision.ts`)** – Adds static/instance helpers (`createFirstRevision`, `newRevision`, etc.) to models flagged with `hasRevisions: true`.
- **Type helpers (`dal/lib/type.ts`)** – Fluent schema builders that feed manifest inference, including virtual field descriptors and multilingual string support via `mlString`.

## Bootstrap & Lifecycle

```ts
import createDataAccessLayer, { DataAccessLayer } from '../dal/index.ts';
import { initializeManifestModels } from '../dal/lib/create-model.ts';

const dal = createDataAccessLayer();
await dal.connect();
initializeManifestModels(dal); // registers every manifest that was imported during bootstrap
```

The DAL is initialised once at startup. Tests and fixtures may spin up isolated instances; disconnecting a DAL clears its registry so cached constructors do not leak across runs.

## Defining Models

Models live under `models/` and export the manifest-driven constructor:

```ts
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { ModelInstance } from '../dal/lib/model-types.ts';
import types from '../dal/lib/type.ts';

const userManifest = defineModelManifest({
  tableName: 'users',
  hasRevisions: false,
  schema: {
    id: types.string().uuid(4),
    displayName: types.string().max(128).required(),
    suppressedNotices: types.array(types.string()),
    urlName: types
      .virtual()
      .returns<string | undefined>()
      .default(function (this: ModelInstance) {
        const displayName = this.getValue('displayName');
        return displayName ? encodeURIComponent(String(displayName).replace(/ /g, '_')) : undefined;
      }),
  },
  camelToSnake: {
    displayName: 'display_name',
    suppressedNotices: 'suppressed_notices',
  },
  relations: [
    {
      name: 'meta',
      targetTable: 'user_metas',
      sourceKey: 'userMetaID',
      targetKey: 'id',
      hasRevisions: true,
      cardinality: 'one',
    },
  ] as const,
});

export default defineModel(userManifest);
```

Manifests drive all type inference:

- `InferData` and `InferVirtual` extract stored and virtual fields from the schema builders.
- `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions` and merges manifest-defined instance methods.
- Static methods declared in the manifest receive the correctly typed constructor via contextual `ThisType`.

## Querying Data

Every manifest-based model ships two query entry points:

- **`Model.filter(criteria)`** – Legacy ReQL-style proxy that accepts `Partial<TData>` or a predicate callback. It remains untyped and should be phased out.
- **`Model.filterWhere(literal)`** – Typed builder defined in `dal/lib/filter-where.ts`. Features include:
  - Typed predicate literals keyed by manifest fields.
  - Operator helpers exposed via `Model.ops` (`neq`, `gt/gte/lt/lte`, `in`, `between/notBetween`, `containsAll`, `containsAny`, `jsonContains`, `not`).
  - Automatic revision guards (`_old_rev_of IS NULL`, `_rev_deleted = false`) with opt-outs (`includeDeleted()`, `includeStale()`).
  - Fluent chaining (`and`, `or`, `revisionData`, `orderBy`, `limit`, `offset`, `getJoin`, `whereIn`, `delete`, `count`).
  - Promise-like behaviour so `await Model.filterWhere({ ... })` works without `.run()`.

Example:

```ts
const { containsAll, neq } = Thing.ops;
const things = await Thing.filterWhere({ urls: containsAll(targetUrls) })
  .and({ createdBy: neq(blockedUserId) })
  .orderBy('created_on', 'DESC')
  .limit(25)
  .run();
```

## Revisions

Models with `hasRevisions: true` gain revision metadata fields and helpers:

- Static helpers (`createFirstRevision`, `getNotStaleOrDeleted`, revision-aware `filterWhere`, etc.).
- Instance helpers (`newRevision`, `deleteAllRevisions`).
- `filterWhere.revisionData()` exposes typed predicates for `_rev*` columns when querying revision metadata.

## Directory Reference

- `dal/index.ts` – Public entry point that re-exports constructors, types, and helpers.
- `dal/lib/` – Core implementation (connection management, manifests, query builder, filters, revision system, schema types).
- `dal/setup-db-grants.sql` – Grants applied to shared environments.
- `models/` – Declarative manifests and behaviour for each domain model.
- `migrations/` – PostgreSQL schema migrations consumed by `DataAccessLayer.migrate()`.

## Current Priorities

See `plans/DAL-ROADMAP.md` for the live modernization backlog, including `filterWhere` adoption, richer operator coverage, and relation typing improvements.
