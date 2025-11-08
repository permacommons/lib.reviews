type ExampleRecord = {
  id: string;
  status: string;
  score: number;
  createdOn: Date;
  isActive: boolean | null;
  metadata: Record<string, unknown>;
  tags: string[];
};

type ExtractArray<T> = Extract<T, readonly unknown[] | unknown[]>;

type ArrayElement<T> = ExtractArray<T> extends readonly (infer U)[]
  ? U
  : ExtractArray<T> extends (infer U)[]
    ? U
    : never;

type EqualityComparablePrimitive = string | number | bigint | boolean | Date;
type ComparablePrimitive = string | number | bigint | Date;

type EqualityComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends EqualityComparablePrimitive ? K : never;
}[keyof T];

type ComparableKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends ComparablePrimitive ? K : never;
}[keyof T];

type JsonObjectKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends Record<string, unknown> ? K : never;
}[keyof T];

type StringArrayKeys<T> = {
  [K in keyof T]-?: ExtractArray<T[K]> extends never
    ? never
    : ArrayElement<T[K]> extends string
      ? K
      : never;
}[keyof T];

type BooleanKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends boolean ? K : never;
}[keyof T];

const eqStatus: EqualityComparableKeys<ExampleRecord> = 'status';
const eqScore: EqualityComparableKeys<ExampleRecord> = 'score';
// @ts-expect-error metadata is not equality comparable
const eqMetadata: EqualityComparableKeys<ExampleRecord> = 'metadata';

const cmpCreatedOn: ComparableKeys<ExampleRecord> = 'createdOn';
// @ts-expect-error tags array is not comparable
const cmpTags: ComparableKeys<ExampleRecord> = 'tags';

const jsonMetadata: JsonObjectKeys<ExampleRecord> = 'metadata';
// @ts-expect-error status is scalar, not JSON
const jsonStatus: JsonObjectKeys<ExampleRecord> = 'status';

const arrayTags: StringArrayKeys<ExampleRecord> = 'tags';
// @ts-expect-error score is not a string array
const arrayScore: StringArrayKeys<ExampleRecord> = 'score';

const boolKey: BooleanKeys<ExampleRecord> = 'isActive';
// @ts-expect-error status is not boolean-compatible
const boolStatus: BooleanKeys<ExampleRecord> = 'status';
