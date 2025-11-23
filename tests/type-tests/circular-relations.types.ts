/**
 * Test: Bidirectional relation types using referenceX pattern for targetTable.
 *
 * Pattern: import referenceX function, use it as `target` in relation config.
 * At runtime: relation.target().tableName gives the target table.
 */
import { expectTypeOf } from 'expect-type';

import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferInstance, ModelManifest } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

// ============================================
// MODEL A: "Thing" equivalent
// ============================================

const thingManifest = {
  tableName: 'things',
  hasRevisions: true as const,
  schema: {
    id: types.string().required(),
    name: types.string().required(),
  },
  relations: [
    {
      name: 'reviews',
      target: referenceReview,  // Lazy lookup - gets tableName at runtime
      sourceKey: 'id',
      targetKey: 'thing_id',
      cardinality: 'many' as const,
    },
  ],
} as const satisfies ModelManifest;

type ThingInstanceBase = InferInstance<typeof thingManifest>;

export type ThingInstance = ThingInstanceBase & {
  reviews: ReviewInstance[];
};

export function referenceThing() {
  return referenceModel(thingManifest);
}

// ============================================
// MODEL B: "Review" equivalent
// ============================================

const reviewManifest = {
  tableName: 'reviews',
  hasRevisions: true as const,
  schema: {
    id: types.string().required(),
    thing_id: types.string().required(),
  },
  relations: [
    {
      name: 'thing',
      target: referenceThing,  // Lazy lookup - gets tableName at runtime
      sourceKey: 'thing_id',
      cardinality: 'one' as const,
    },
  ],
} as const satisfies ModelManifest;

type ReviewInstanceBase = InferInstance<typeof reviewManifest>;

export type ReviewInstance = ReviewInstanceBase & {
  thing: ThingInstance | undefined;
};

export function referenceReview() {
  return referenceModel(reviewManifest);
}

// ============================================
// TYPE TESTS
// ============================================

// Test: ThingInstance has the data fields
expectTypeOf<ThingInstance>().toHaveProperty('id');
expectTypeOf<ThingInstance>().toHaveProperty('name');

// Test: ThingInstance has the relation field with correct type
expectTypeOf<ThingInstance>().toHaveProperty('reviews');
declare const thing: ThingInstance;
expectTypeOf(thing.reviews).toEqualTypeOf<ReviewInstance[]>();

// Test: ReviewInstance has the data fields
expectTypeOf<ReviewInstance>().toHaveProperty('id');
expectTypeOf<ReviewInstance>().toHaveProperty('thing_id');

// Test: ReviewInstance has the relation field with correct type
expectTypeOf<ReviewInstance>().toHaveProperty('thing');
declare const review: ReviewInstance;
expectTypeOf(review.thing).toEqualTypeOf<ThingInstance | undefined>();

// Test: Can traverse the circular reference
expectTypeOf(thing.reviews[0].thing).toEqualTypeOf<ThingInstance | undefined>();
expectTypeOf(review.thing!.reviews[0]).toEqualTypeOf<ReviewInstance>();

// Test: target() returns model with tableName
declare const relation: { target: typeof referenceReview };
const targetModel = relation.target();
expectTypeOf(targetModel).toHaveProperty('tableName');
