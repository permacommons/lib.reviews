import { expectTypeOf } from 'expect-type';

import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance, ModelManifest } from '../../dal/lib/model-manifest.ts';
import type { InstanceMethod } from '../../dal/lib/model-types.ts';
import types from '../../dal/lib/type.ts';

// Define schema first
const exampleSchema = {
  id: types.string().required(),
  label: types.string(),
  computed: types.virtual().returns<number>(),
} as const;

// Define instance base type for method `this` typing
type ExampleInstanceBase = InferInstance<{
  tableName: 'example_table';
  hasRevisions: false;
  schema: typeof exampleSchema;
}>;

// Define methods in separate interfaces (recommended pattern)
interface ExampleStaticMethods {
  findByLabel(label: string): Promise<string | null>;
}

interface ExampleInstanceMethods extends Record<string, InstanceMethod<ExampleInstanceBase>> {
  getLabel(this: ExampleInstanceBase & ExampleInstanceMethods): string | null;
}

const exampleManifest = {
  tableName: 'example_table',
  hasRevisions: false as const,
  schema: exampleSchema,
} as const satisfies ModelManifest;

type ExampleConstructor = InferConstructor<typeof exampleManifest>;
type ExampleInstance = InferInstance<typeof exampleManifest>;

const exampleHandle = referenceModel(exampleManifest);

expectTypeOf(exampleHandle).toMatchTypeOf<ExampleConstructor>();
expectTypeOf(exampleHandle.createFromRow).returns.toEqualTypeOf<ExampleInstance>();

type ExampleGetResult = Awaited<ReturnType<typeof exampleHandle.get>>;
expectTypeOf<ExampleGetResult>().toEqualTypeOf<ExampleInstance | null>();

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
