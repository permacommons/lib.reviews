/**
 * Type tests for model handles and referenceModel()
 *
 * These tests verify that referenceModel() correctly produces typed model handles
 * with proper inference for static methods, instance types, and extra properties.
 */
import { expectTypeOf } from 'expect-type';

import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferConstructor,
  InferInstance,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

// Define schema first
const exampleSchema = {
  id: types.string().required(),
  label: types.string(),
  relatedId: types.string(),
  computed: types.virtual().returns<number>(),
  // Note: relation fields are typed via intersection pattern, not schema virtuals
} as const;

// Define manifest with relations
const exampleManifest = {
  tableName: 'example_table',
  hasRevisions: false as const,
  schema: exampleSchema,
  relations: [
    {
      name: 'related',
      targetTable: 'related_items',
      sourceKey: 'relatedId',
      targetKey: 'id',
      cardinality: 'one',
    },
  ],
} as const satisfies ModelManifest;

// Define instance base type for method `this` typing
type ExampleInstanceBase = InferInstance<typeof exampleManifest>;

// Define methods in separate interfaces (recommended pattern)
// Do NOT use `extends Record<string, ...>` - it conflicts with intersection pattern
interface ExampleStaticMethods {
  findByLabel(label: string): Promise<string | null>;
}

interface ExampleInstanceMethods {
  getLabel(this: ExampleInstanceBase & ExampleInstanceMethods): string | null;
}

// Mock related type for intersection pattern demo
interface RelatedInstance {
  id: string;
  name: string;
}

// Use intersection pattern to add relation types
type ExampleInstance = ExampleInstanceBase &
  ExampleInstanceMethods & {
    related?: RelatedInstance;
  };

// Verify method interface shapes are valid
expectTypeOf<ExampleStaticMethods['findByLabel']>().returns.resolves.toEqualTypeOf<string | null>();
expectTypeOf<ExampleInstanceMethods['getLabel']>().returns.toEqualTypeOf<string | null>();

// Verify intersection pattern works - relation field is properly typed
declare const instance: ExampleInstance;
expectTypeOf(instance.related).toEqualTypeOf<RelatedInstance | undefined>();
expectTypeOf(instance.id).toEqualTypeOf<string>();
expectTypeOf(instance.label).toEqualTypeOf<string | null | undefined>();

type ExampleConstructor = InferConstructor<typeof exampleManifest>;

const exampleHandle = referenceModel(exampleManifest);

expectTypeOf(exampleHandle).toMatchTypeOf<ExampleConstructor>();
expectTypeOf(exampleHandle.createFromRow).returns.toEqualTypeOf<ExampleInstanceBase>();

type ExampleGetResult = Awaited<ReturnType<typeof exampleHandle.get>>;
expectTypeOf<ExampleGetResult>().toEqualTypeOf<ExampleInstanceBase | null>();

const handleWithMethods = referenceModel(exampleManifest, {
  parseNumber(value: string) {
    return Number(value);
  },
});

expectTypeOf(handleWithMethods.parseNumber).returns.toEqualTypeOf<number>();

const handleWithProperties = referenceModel(exampleManifest, undefined, {
  category: 'demo' as const,
});

expectTypeOf(handleWithProperties).toMatchTypeOf<{ category: unknown }>();
expectTypeOf(handleWithProperties.category).not.toEqualTypeOf<never>();

const handleWithAll = referenceModel(
  exampleManifest,
  {
    isPositive(value: number) {
      return value > 0;
    },
  },
  {
    description: 'typed handle' as const,
  }
);

expectTypeOf(handleWithAll.isPositive).returns.toEqualTypeOf<boolean>();
expectTypeOf(handleWithAll).toMatchTypeOf<{ description: unknown }>();
expectTypeOf(handleWithAll.description).not.toEqualTypeOf<never>();
