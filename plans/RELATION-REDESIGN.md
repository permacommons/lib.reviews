# Relation System Redesign

Strongly typed relations with support for bidirectional references.

## Problem

Relations require both runtime metadata and TypeScript types:

```ts
// Runtime: join metadata
relations: [
  { name: 'thing', targetTable: 'things', sourceKey: 'thing_id', cardinality: 'one' },
]

// Type: instance field type
schema: {
  thing: types.virtual<ThingInstance>().default(undefined),
}
```

For bidirectional relations (thing ↔ review), circular type imports cause
`TS2456: Type alias circularly references itself` errors.

## Solution

**Plain relation objects + intersection pattern for types.**

### Relation Definition

Relations are plain objects in the manifest:

```ts
const reviewManifest = {
  relations: [
    {
      name: 'thing',
      targetTable: 'things',  // Explicit table name
      sourceKey: 'thing_id',
      cardinality: 'one',
    },
    // OR use target function for DRY table lookup:
    {
      name: 'thing',
      target: referenceThing,  // () => model with tableName
      sourceKey: 'thing_id',
      cardinality: 'one',
    },
  ],
} as const satisfies ModelManifest;
```

### Typing Bidirectional Relations

Use the **intersection pattern** to add relation types without circularity:

```ts
// thing.ts
import type { ReviewInstance } from './review.ts';  // Type-only import

const thingManifest = {
  relations: [
    { name: 'reviews', targetTable: 'reviews', sourceKey: 'id', targetKey: 'thing_id', cardinality: 'many' },
  ],
} as const satisfies ModelManifest;

type ThingInstanceBase = InferInstance<typeof thingManifest>;

// Add relation type via intersection - handles circularity
export type ThingInstance = ThingInstanceBase & {
  reviews: ReviewInstance[];
};

export function referenceThing() { return referenceModel(thingManifest); }
```

```ts
// review.ts
import type { ThingInstance } from './thing.ts';  // Type-only import

const reviewManifest = {
  relations: [
    { name: 'thing', targetTable: 'things', sourceKey: 'thing_id', cardinality: 'one' },
  ],
} as const satisfies ModelManifest;

type ReviewInstanceBase = InferInstance<typeof reviewManifest>;

// Add relation type via intersection - handles circularity
export type ReviewInstance = ReviewInstanceBase & {
  thing: ThingInstance | undefined;
};

export function referenceReview() { return referenceModel(reviewManifest); }
```

**Why it works:**

1. `ThingInstanceBase` and `ReviewInstanceBase` derive from manifests with NO cross-references
2. Base types resolve independently
3. The intersection `{ reviews: ReviewInstance[] }` resolves lazily
4. TypeScript handles circular type aliases when grounded in non-circular bases

### Alternative: Schema Virtuals (Legacy)

For backward compatibility, schema virtuals still work:

```ts
schema: {
  thing: types.virtual<ThingInstance>().default(undefined),
},
relations: [
  { name: 'thing', targetTable: 'things', sourceKey: 'thing_id', cardinality: 'one' },
]
```

This duplicates the type definition but is compatible with existing code.

## RelationDefinition Type

```ts
interface RelationDefinition {
  name: string;
  targetTable?: string;           // Explicit table, OR use target
  target?: () => unknown;         // Lazy model reference (has tableName)
  sourceKey?: string;
  targetKey?: string;
  cardinality?: 'one' | 'many';
  hasRevisions?: boolean;
  through?: {                     // For many-to-many
    table: string;
    sourceForeignKey?: string;
    targetForeignKey?: string;
  };
}
```

## Manifest Pattern

All manifests use `as const satisfies ModelManifest`:

```ts
const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: { ... },
  relations: [ ... ],
} as const satisfies ModelManifest;
```

Instance methods use separate interfaces with explicit `this` typing:

```ts
interface ReviewInstanceMethods extends Record<string, InstanceMethod<ReviewInstanceBase>> {
  populateUserInfo(this: ReviewInstanceBase & ReviewInstanceMethods, user: UserAccessContext): void;
}

export default defineModel(reviewManifest, { instanceMethods: reviewInstanceMethods });
```

## Remaining Work

### Include API

Add `include` option to query methods for relation hydration:

```ts
const review = await Review.get(id, { include: ['thing', 'creator'] });
review.thing    // ThingInstance (populated)
review.creator  // UserView (populated)
```

This builds on existing `loadManyRelated` infrastructure.

### Runtime Target Resolution

When `target` function is provided instead of `targetTable`:

1. At query time, call `target()` to get the model
2. Use `model.tableName` for the join
3. Validate table matches relation expectations

### Migration

Migrate manifests to intersection pattern incrementally:

1. Add intersection type for relation field
2. Remove corresponding schema virtual
3. Verify types still work

## Success Criteria

- [x] Plain relation objects work (no special helpers needed)
- [x] Bidirectional relations compile without circular errors
- [x] `as const satisfies ModelManifest` pattern adopted
- [x] `target` function supported for DRY table lookup
- [ ] At least one manifest fully migrated to intersection pattern
- [ ] `include` option works for relation hydration
