import { expectTypeOf } from 'expect-type';

import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { InferConstructor, InferInstance } from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';

const exampleManifest = defineModelManifest({
  tableName: 'example_table',
  hasRevisions: false,
  schema: {
    id: types.string().required(),
    label: types.string(),
    computed: types.virtual().returns<number>(),
  },
  staticMethods: {
    async findByLabel(label: string) {
      return Promise.resolve(label ?? null);
    },
  },
  instanceMethods: {
    getLabel() {
      return this.label ?? null;
    },
  },
} as const);

type ExampleConstructor = InferConstructor<typeof exampleManifest>;
type ExampleInstance = InferInstance<typeof exampleManifest>;

const exampleHandle = referenceModel(exampleManifest);

expectTypeOf(exampleHandle).toMatchTypeOf<ExampleConstructor>();
expectTypeOf(exampleHandle.findByLabel).toBeFunction();
expectTypeOf(exampleHandle.findByLabel).returns.toEqualTypeOf<Promise<string | null>>();
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
