# PostgreSQL Data Access Layer

The lib.reviews DAL is a TypeScript-first PostgreSQL abstraction that exposes typed model constructors, revision helpers, and a fluent query builder. Application code imports models synchronously while bootstrap wires them to a live `pg` connection exactly once.

## Core Building Blocks

- **DataAccessLayer (`dal/lib/data-access-layer.ts`)** – Owns the shared `pg.Pool`, manages migrations, and keeps a per-instance `ModelRegistry` so constructors are isolated between DALs (useful for fixtures/tests).
- **Model runtime (`dal/lib/model.ts`)** – Implements camelCase ↔︎ snake_case mapping, validation/default handling, change tracking, and persistence primitives consumed by every manifest-driven model.
- **Manifest system (`dal/lib/create-model.ts`, `dal/lib/model-manifest.ts`)** – Declarative manifests define schema, relations, revision support, and custom methods. `defineModel` returns a lazy proxy constructor whose types are inferred from the manifest.
- **Query builder (`dal/lib/query-builder.ts`)** – Builds SQL fragments for predicates, joins, ordering, pagination, and deletes. `filterWhere` wraps it with typed predicates for day-to-day usage.
  - Chainables include `orderBy/limit/offset`, `whereIn`, `getJoin` (auto-selects inline or batch join based on cardinality), `whereRelated` (predicate on a related table via manifest metadata), and `chronologicalFeed` for date-backed limit+1 pagination.
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
import dal from '../../dal/index.ts';
import type { ManifestInstance, ManifestModel } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';

const { types } = dal;

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

const userManifest = {
  tableName: 'users',
  hasRevisions: false as const,
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
} as const satisfies ModelManifest;

export type UserInstance = ManifestInstance<typeof userManifest>;
export type UserModel = ManifestModel<typeof userManifest>;

// For models WITH relations, use intersection pattern for strong typing:
// export type UserInstance = ManifestInstance<typeof userManifest> & {
//   meta?: UserMetaInstance;
//   teams?: TeamInstance[];
// };

// Export reference helper for other models to use
export function referenceUser(): UserModel {
  return referenceModel(userManifest) as UserModel;
}

export { userOptions };
export default userManifest;
```

### Relation Definition

Relations are defined as plain objects in the manifest's `relations` array:

```ts
interface RelationDefinition {
  name: string;                     // Field name on the instance
  targetTable?: string;             // Target table name, OR use target()
  target?: () => unknown;           // Lazy model reference (has tableName)
  sourceKey?: string;               // Column on this model (default: 'id')
  targetKey?: string;               // Column on target model (default: 'id')
  cardinality?: 'one' | 'many';     // Affects join strategy when using `true`
  hasRevisions?: boolean;           // Apply revision guards to joined records
  through?: {                       // For many-to-many via junction table
    table: string;
    sourceForeignKey?: string;
    targetForeignKey?: string;
  };
}
```

Example with a many-to-many relation:

```ts
relations: [
  {
    name: 'teams',
    targetTable: 'teams',
    sourceKey: 'id',
    targetKey: 'id',
    hasRevisions: true,
    through: {
      table: 'team_members',
      sourceForeignKey: 'user_id',
      targetForeignKey: 'team_id',
    },
    cardinality: 'many',
  },
]
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

- **Low-level helpers** (internal):
  - `InferData` and `InferVirtual` extract stored and virtual fields from schema builders
  - `InferInstance` switches between `ModelInstance` and `VersionedModelInstance` based on `hasRevisions`
  - `InferConstructor` produces the typed model constructor with CRUD methods
- **Convenience helpers** (recommended for manifest files):
  - `ManifestInstance<Manifest, InstanceMethods>` - cleaner than `InferInstance<MergeManifestMethods<...>>`
  - `ManifestModel<Manifest, StaticMethods, InstanceMethods>` - cleaner than `InferConstructor<MergeManifestMethods<...>>`
- **Bundle helper for manifests**:
  - `ManifestTypes<Manifest, StaticMethods, InstanceMethods, Relations>` packages the data, virtual, instance, and model types
    into a single object. Prefer the bundle over repeating individual inferences in each manifest file.
- Static/instance methods declared via `defineStaticMethods`/`defineInstanceMethods` receive correctly typed `this` via contextual `ThisType`

**Relation Field Typing**: Use the intersection pattern to add strongly-typed relation fields:

```ts
// If you have static/instance methods, define base types first
type UserInstanceBase = ManifestInstance<typeof userManifest, UserInstanceMethods>;

// Add relation types via intersection - fields are optional since they're
// only populated when explicitly loaded via getJoin() or custom queries
export type UserInstance = UserInstanceBase & {
  meta?: UserMetaInstance;
  teams?: TeamInstance[];
};
```

This pattern avoids circular type errors when two models reference each other (e.g., Thing ↔ Review).

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
- Schema definitions as plain objects with `as const satisfies ModelManifest`
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
  - Fluent chaining (`and`, `or`, `revisionData`, `orderBy`, `orderByRelation`, `limit`, `offset`, `getJoin`, `whereRelated`, `whereIn`, `chronologicalFeed`, `delete`, `count`, `average`).
  - Promise-like behaviour so `await Model.filterWhere({ ... })` works without `.run()`.

Example:

```ts
const { containsAll, neq } = Thing.ops;
const things = await Thing.filterWhere({ urls: containsAll(targetUrls) })
  .and({ createdBy: neq(blockedUserId) })
  .orderBy('created_on', 'DESC')
  .limit(25)
  .run();

// Aggregates reuse the same revision-safe predicates
const averageRating = await Review.filterWhere({ thingID }).average('starRating');
const reviewCount = await Review.filterWhere({ thingID }).count();

// Atomic counters for numeric schema fields (throws on non-numeric columns)
const { rows } = await User.filterWhere({ id: someUser }).increment('inviteLinkCount', {
  by: 1,
  returning: ['inviteLinkCount'],
});

// Or decrement the same field atomically
await User.filterWhere({ id: someUser }).decrement('inviteLinkCount', { by: 1 });
```

## Batch Loading Relations

The DAL provides `Model.loadManyRelated()` for efficiently loading many-to-many associations through junction tables. This is especially useful when hydrating lists of records with their related data (the "N+1 query" problem).

### Basic Usage

```ts
// Load teams for multiple reviews in a single query
const reviewIds = reviews.map(r => r.id);
const reviewTeamMap = await Review.loadManyRelated('teams', reviewIds);

// Populate each review with its teams
reviews.forEach(review => {
  review.teams = reviewTeamMap.get(review.id) || [];
});
```

### How It Works

`loadManyRelated()` uses the relation metadata defined in your manifest to:

1. Build a single SQL query that joins through the junction table
2. Apply revision system guards (`_old_rev_of IS NULL`, `_rev_deleted = false`) when needed
3. Group results by source ID
4. Return a `Map<sourceId, TargetInstance[]>` for easy assignment

**Before** (manual SQL):
```ts
const query = `
  SELECT rt.review_id, t.* FROM teams t
  JOIN review_teams rt ON t.id = rt.team_id
  WHERE rt.review_id IN (${placeholders})
    AND (t._old_rev_of IS NULL)
    AND (t._rev_deleted IS NULL OR t._rev_deleted = false)
`;
const result = await dal.query(query, reviewIds);
// Manual grouping logic...
```

**After** (DAL helper):
```ts
const reviewTeamMap = await Review.loadManyRelated('teams', reviewIds);
```

### Requirements

The relation must be defined in your model's manifest with:
- A `through` object specifying the junction table
- Proper `sourceForeignKey` and `targetForeignKey` columns
- Optional `hasRevisions` flag for revision-aware filtering

Example manifest configuration:
```ts
const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: { /* ... */ },
  relations: [
    {
      name: 'teams',
      targetTable: 'teams',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'review_teams',
        sourceForeignKey: 'review_id',
        targetForeignKey: 'team_id',
      },
      cardinality: 'many',
    },
  ] as const,
} as const satisfies ModelManifest;
```

### Edge Cases

- **Empty input**: Returns empty `Map` when given `[]`
- **No matches**: Returns empty `Map` when no associations exist
- **Deleted records**: Automatically excludes soft-deleted related records when `hasRevisions: true`
- **Type safety**: Results are typed as `Map<string, ModelInstance<JsonObject, JsonObject>[]>`, requiring a cast to the specific target type when needed

## Writing Many-to-Many Associations

The DAL provides `Model.addManyRelated()` for batch-inserting associations into many-to-many junction tables. This complements `loadManyRelated()` by handling the write side of many-to-many relationships.

### Basic Usage

```ts
// Associate a thing with multiple files
const Thing = dalFixture.getModel('things');
await Thing.addManyRelated('files', thingId, [file1.id, file2.id]);

// Associate a review with teams
const Review = dalFixture.getModel('reviews');
await Review.addManyRelated('teams', reviewId, teamIds);
```

### How It Works

`addManyRelated()` uses the relation metadata defined in your manifest to:

1. Build a parameterized INSERT query for the junction table
2. Apply schema namespace prefixing for test isolation
3. Handle duplicate associations gracefully via `ON CONFLICT DO NOTHING` (default)
4. Validate inputs and provide helpful error messages

**Before** (manual SQL):
```ts
const runtime = this.constructor as Record<string, any>;
const dalInstance = runtime.dal as Record<string, any>;
const junctionTable = dalInstance.schemaNamespace
  ? `${dalInstance.schemaNamespace}thing_files`
  : 'thing_files';
const insertValues: Array<string | undefined> = [];
const valueClauses: string[] = [];
let paramIndex = 1;

validFiles.forEach(file => {
  valueClauses.push(`($${paramIndex}, $${paramIndex + 1})`);
  insertValues.push(this.id, file.id);
  paramIndex += 2;
});

if (valueClauses.length) {
  const insertQuery = `
    INSERT INTO ${junctionTable} (thing_id, file_id)
    VALUES ${valueClauses.join(', ')}
    ON CONFLICT DO NOTHING
  `;
  await dalInstance.query(insertQuery, insertValues);
}
```

**After** (DAL helper):
```ts
const Thing = this.constructor as ThingModel;
await Thing.addManyRelated('files', this.id!, validFiles.map(f => f.id!));
```

### Requirements

The relation must be defined in your model's manifest with:
- A `through` object specifying the junction table
- Proper `sourceForeignKey` and `targetForeignKey` columns
- `cardinality: 'many'`

Example manifest configuration:
```ts
const thingManifest = {
  hasRevisions: true as const,
  tableName: 'things',
  relations: [
    {
      name: 'files',
      targetTable: 'files',
      sourceKey: 'id',
      targetKey: 'id',
      hasRevisions: true,
      through: {
        table: 'thing_files',
        sourceForeignKey: 'thing_id',
        targetForeignKey: 'file_id',
      },
      cardinality: 'many',
    },
  ] as const,
} as const satisfies ModelManifest;
```

### Conflict Handling

By default, duplicate associations are silently ignored:

```ts
// Associate once
await Review.addManyRelated('teams', reviewId, [teamId]);

// Associate again - no error, no duplicate row
await Review.addManyRelated('teams', reviewId, [teamId]);
```

For strict validation, use `{ onConflict: 'error' }`:

```ts
await Review.addManyRelated('teams', reviewId, [teamId], { onConflict: 'error' });
// Throws if association already exists
```

### Edge Cases

- **Empty input**: Returns immediately when given `[]` with no database query
- **Invalid relation**: Throws helpful error listing available relations
- **Non-junction relation**: Throws error if relation doesn't have a `through` table
- **Invalid source ID**: Throws error for empty or non-string source IDs
- **Schema isolation**: Automatically handles test namespace prefixing

### Instance Method Pattern

When writing instance methods that create associations, follow this pattern:

```ts
async addFilesByIDsAndSave(this: ThingInstance, fileIDs: string[]): Promise<ThingInstance> {
  // 1. Validate and fetch related records
  const { in: inOp } = File.ops;
  const validFiles = await File.filterWhere({ id: inOp(fileIDs as [string, ...string[]]) }).run();

  if (!validFiles.length) {
    return this;
  }

  // 2. Insert associations using static helper
  const Thing = this.constructor as ThingModel;
  await Thing.addManyRelated('files', this.id!, validFiles.map(f => f.id!));

  // 3. Update in-memory representation
  this.files = [...(this.files ?? []), ...validFiles];

  return this;
}
```

## Revisions

Models with `hasRevisions: true` gain revision metadata fields and helpers:

- Static helpers (`createFirstRevision`, `getNotStaleOrDeleted`, revision-aware `filterWhere`, etc.).
- Instance helpers (`newRevision`, `deleteAllRevisions`).
- `filterWhere.revisionData()` exposes typed predicates for `_rev*` columns when querying revision metadata.

## Multilingual Strings

The DAL provides runtime-validated multilingual string schemas via `mlString` (imported from `dal/lib/ml-string.ts`). These enforce a security model that distinguishes plain text from HTML content at write time.

### Storage Format

Text fields store **HTML-safe text** with entities escaped (e.g., `My &amp; Co`, `I &lt;3 JS`) but HTML tags rejected. This preserves users' literal input including angle brackets while allowing safe rendering in HTML templates.

- User types `A & B` → stored as `{ en: "A &amp; B" }` → browser displays `A & B`
- Adapter returns `<b>Title</b>` → stripped to `Title` → stored as `{ en: "Title" }`
- For plain text contexts (emails, exports), decode entities with `decodeHTML()` from the `entities` package

### Schema Methods

**Plain Text (HTML-safe)** – For labels, titles, names, descriptions

```ts
import mlString from '../../dal/lib/ml-string.ts';

const thingManifest = {
  hasRevisions: true as const,
  schema: {
    label: mlString.getSafeTextSchema({ maxLength: 256 }),
    aliases: mlString.getSafeTextSchema({ array: true, maxLength: 256 }),
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Rejects HTML tags at write time via `ValidationError`.

**HTML Content** – For cached rendered markdown output

```ts
const reviewManifest = {
  hasRevisions: true as const,
  schema: {
    html: mlString.getHTMLSchema(),
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Permits full HTML markup. Use only for pre-sanitized content.

**Rich Text (Nested)** – For fields storing both markdown source and cached HTML

```ts
const teamManifest = {
  hasRevisions: true as const,
  schema: {
    description: mlString.getRichTextSchema(),
    // Expects: { text: { en: "markdown" }, html: { en: "<p>HTML</p>" } }
  },
  // ... other fields
} as const satisfies ModelManifest;
```

Validates nested structure: `text` must be HTML-safe, `html` may contain tags.

### Template Rendering

```handlebars
{{!-- Plain text (entity-escaped at storage) --}}
<h1>{{mlSafeText review.title}}</h1>
<meta content="{{mlSafeText thing.label false}}" />

{{!-- Pre-rendered HTML --}}
<div>{{{mlHTML review.html}}}</div>
<div>{{{mlHTML team.description.html}}}</div>
```

Both helpers support language fallbacks and optional language indicators.

### Security Model

Defense in depth against XSS:

1. **Input sanitization** – Adapters/forms escape entities at write time
2. **Runtime validation** – Schemas reject `<script>` in text fields
3. **Template safety** – Explicit `mlSafeText` vs `mlHTML` helpers
4. **User feedback** – Flash middleware converts validation errors to localized messages

### Helper Methods

```ts
// Resolve translation with fallbacks
const resolved = mlString.resolve('de', thing.label);
// Returns: { str: "Label text", lang: "en" }

// Strip HTML from external data
const cleaned = mlString.stripHTML({ en: '<b>Bold</b> text' });
// Returns: { en: 'Bold text' }

// Build JSONB query predicates
const query = mlString.buildQuery('label', 'en', searchTerm, 'ILIKE');
// Returns: "label->>'en' ILIKE $1"
```

## Directory Reference

- `dal/index.ts` – Public entry point that re-exports constructors, types, and helpers.
- `dal/lib/` – Core implementation (connection management, manifests, query builder, filters, revision system, schema types).
- `dal/setup-db-grants.sql` – Grants applied to shared environments.
- `models/manifests/` – Schema declarations, types, validation helpers, and cross-model reference functions.
- `models/` – Runtime model implementations with complex static/instance methods.
- `migrations/` – PostgreSQL schema migrations consumed by `DataAccessLayer.migrate()`.

## Current Priorities

See `plans/DAL-ROADMAP.md` for the live modernization backlog, including `filterWhere` adoption, richer operator coverage, and relation typing improvements.
