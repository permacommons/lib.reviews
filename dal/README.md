# PostgreSQL Data Access Layer

The lib.reviews DAL is a TypeScript-first PostgreSQL abstraction that exposes typed model constructors, revision helpers, and a fluent query builder. Application code imports models synchronously while bootstrap wires them to a live `pg` connection exactly once.

## Core Building Blocks

- **DataAccessLayer (`dal/lib/data-access-layer.ts`)** – Owns the shared `pg.Pool`, manages migrations, and keeps a per-instance `ModelRegistry` so constructors are isolated between DALs (useful for fixtures/tests).
- **Model runtime (`dal/lib/model.ts`)** – Implements camelCase ↔︎ snake_case mapping, validation/default handling, change tracking, and persistence primitives consumed by every manifest-driven model.
- **Manifest system (`dal/lib/create-model.ts`, `dal/lib/model-manifest.ts`)** – Declarative manifests define schema, relations, revision support, and custom methods. `defineModel` returns a lazy proxy constructor whose types are inferred from the manifest.
- **Query builder (`dal/lib/query-builder.ts`)** – Builds SQL fragments for predicates, joins, ordering, pagination, and deletes. `filterWhere` wraps it with typed predicates for day-to-day usage.
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

Models are split across two directories to avoid circular imports:

- **`models/manifests/`** – Schema declarations, types, validation helpers, and cross-model reference functions
- **`models/`** – Runtime behavior (complex static/instance methods that depend on other models)

### Basic Structure

```ts
// models/manifests/user.ts - Schema, types, validation helpers
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

// Model-specific options and helpers
const userOptions = {
  maxChars: 128,
  illegalChars: /[<>;"&?!./_]/,
  minPasswordLength: 6,
};

export function canonicalize(name: string): string {
  return name.toUpperCase();
}

function containsOnlyLegalCharacters(name: string): true {
  if (userOptions.illegalChars.test(name)) {
    throw new Error(`Username ${name} contains invalid characters.`);
  }
  return true;
}

const userManifest = defineModelManifest({
  tableName: 'users',
  hasRevisions: false,
  schema: {
    id: types.string().uuid(4),
    displayName: types
      .string()
      .max(userOptions.maxChars)
      .validator(containsOnlyLegalCharacters)
      .required(),
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

export type UserInstance = InferInstance<typeof userManifest>;
export type UserModel = InferConstructor<typeof userManifest>;

// Export reference helper for other models to use
export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export { userOptions };
export default userManifest;
```

```ts
// models/user.ts - Runtime behavior
import { defineModel, defineStaticMethods } from '../dal/lib/create-model.ts';
import userManifest, { type UserInstance, type UserModel } from './manifests/user.ts';
import { referenceTeam } from './manifests/team.ts';

// Safe cross-model reference - no circular import!
const Team = referenceTeam();

const userStaticMethods = defineStaticMethods(userManifest, {
  async findByEmail(this: UserModel, email: string) {
    return this.filterWhere({ email }).run();
  },

  async getWithTeams(this: UserModel, id: string) {
    const user = await this.get(id);
    if (user) {
      user.teams = await Team.filterWhere({ /* ... */ }).run();
    }
    return user;
  }
});

export default defineModel(userManifest, { staticMethods: userStaticMethods });
```

### Type Inference

Manifests drive all type inference:

- `InferData` and `InferVirtual` extract stored and virtual fields from the schema builders.
- `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions` and merges manifest-defined instance methods.
- `InferConstructor` produces the typed model constructor with CRUD methods.
- Static/instance methods declared via `defineStaticMethods`/`defineInstanceMethods` receive the correctly typed `this` via contextual `ThisType`.

### Cross-Model References

Use `referenceModel()` to safely import other models without circular dependencies:

```ts
// In models/thing.ts
import { referenceReview, type ReviewInstance } from './manifests/review.ts';

const Review = referenceReview();

// Can now call Review.filterWhere(...) safely
const reviews = await Review.filterWhere({ thingID: thing.id }).run();
```

The manifest exports a typed reference function that returns a lazy proxy. The actual model is resolved at runtime after bootstrap completes.

### What Goes Where?

**Manifests** (`models/manifests/`) contain:
- Schema definitions via `defineModelManifest`
- Type exports (`UserInstance`, `UserModel`, etc.)
- Validation functions used in schema validators
- Model-specific constants and options
- Cross-model reference functions (`referenceUser()`, etc.)
- Simple helper functions with no external model dependencies

**Runtime models** (`models/`) contain:
- Complex static methods that query other models
- Instance methods that interact with related models
- Business logic that requires calling multiple models
- Methods that need fully-initialized DAL helpers

**Rule of thumb**: If it needs to call another model's methods, put it in `models/`. If it's pure validation, types, or schema, put it in `models/manifests/`.

## Querying Data

Every manifest-based model ships a typed query entry point:

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
- `models/manifests/` – Schema declarations, types, validation helpers, and cross-model reference functions.
- `models/` – Runtime model implementations with complex static/instance methods.
- `migrations/` – PostgreSQL schema migrations consumed by `DataAccessLayer.migrate()`.

## Current Priorities

See `plans/DAL-ROADMAP.md` for the live modernization backlog, including `filterWhere` adoption, richer operator coverage, and relation typing improvements.
