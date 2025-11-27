import { ValidationError } from './errors.ts';

export type ValidatorFunction<TValue> = (value: TValue) => boolean | void;

type TypeOutput<TBase, TRequired extends boolean> = TRequired extends true
  ? TBase
  : TBase | null | undefined;

type SchemaFieldLike = { validate(value: unknown, fieldName?: string): unknown };

export type InferFieldValue<Field extends SchemaFieldLike> = Field extends {
  validate(value: unknown, fieldName?: string): infer TValue;
}
  ? TValue
  : never;

/**
 * Base type class used for declarative schema definitions.
 */
export class Type<TBase, TRequired extends boolean = false> {
  options: Record<string, unknown>;
  validators: ValidatorFunction<TBase>[];
  protected _required: boolean;
  defaultValue?: TypeOutput<TBase, TRequired> | (() => TypeOutput<TBase, TRequired>);
  hasDefault: boolean;
  isSensitive: boolean;
  isVirtual: boolean;

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    this.validators = [];
    this._required = false;
    this.defaultValue = undefined;
    this.hasDefault = false;
    this.isSensitive = false;
    this.isVirtual = false;
  }

  /**
   * Add a validator function that will receive the normalized value.
   */
  validator(validator: ValidatorFunction<TBase>): this {
    if (typeof validator === 'function') {
      this.validators.push(validator);
    }
    return this;
  }

  /**
   * Mark the field as required or optional.
   */
  required<T extends boolean = true>(isRequired = true as T): Type<TBase, T> {
    this._required = Boolean(isRequired);
    return this as unknown as Type<TBase, T>;
  }

  /**
   * Configure a default value (or factory) for the field.
   */
  default(value: TypeOutput<TBase, TRequired> | (() => TypeOutput<TBase, TRequired>)): this {
    this.defaultValue = value;
    this.hasDefault = true;
    return this;
  }

  /**
   * Flag the field as sensitive so joins/exposures can omit it by default.
   */
  sensitive(isSensitive = true): this {
    this.isSensitive = isSensitive;
    return this;
  }

  protected runValidators(value: TBase, fieldName: string): void {
    for (const validator of this.validators) {
      try {
        const result = validator(value);
        if (result === false) {
          throw new ValidationError(`Validation failed for ${fieldName}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ValidationError(`Validation error for ${fieldName}: ${message}`);
      }
    }
  }

  /**
   * Validate the supplied value and return the normalized result.
   */
  validate(value: unknown, fieldName = 'field'): TypeOutput<TBase, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<TBase, TRequired>;
    }

    this.runValidators(value as TBase, fieldName);
    return value as TypeOutput<TBase, TRequired>;
  }

  /**
   * Resolve a configured default for the field, if any.
   */
  getDefault(): TypeOutput<TBase, TRequired> | undefined {
    if (!this.hasDefault) {
      return undefined;
    }

    if (typeof this.defaultValue === 'function') {
      return (this.defaultValue as () => TypeOutput<TBase, TRequired>)();
    }

    return this.defaultValue;
  }
}

/**
 * String type definition with common helpers.
 */
export class StringType<TRequired extends boolean = false> extends Type<string, TRequired> {
  maxLength: number | null;
  minLength: number | null;
  enumValues: string[] | null;

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.maxLength = null;
    this.minLength = null;
    this.enumValues = null;
  }

  max(length: number): this {
    this.maxLength = length;
    return this;
  }

  min(length: number): this {
    this.minLength = length;
    return this;
  }

  enum(values: string | string[]): this {
    this.enumValues = Array.isArray(values) ? values : [values];
    return this;
  }

  email(): this {
    this.validator(value => {
      if (typeof value !== 'string') {
        throw new ValidationError('Must be a valid email address');
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        throw new ValidationError('Must be a valid email address');
      }
      return true;
    });
    return this;
  }

  uuid(_version = 4): this {
    this.validator(value => {
      if (typeof value !== 'string') {
        throw new ValidationError('Must be a valid UUID');
      }
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        throw new ValidationError('Must be a valid UUID');
      }
      return true;
    });
    return this;
  }

  override required<T extends boolean = true>(isRequired = true as T): StringType<T> {
    super.required(isRequired);
    return this as unknown as StringType<T>;
  }

  override validate(value: unknown, fieldName = 'field'): TypeOutput<string, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<string, TRequired>;
    }

    if (typeof value !== 'string') {
      throw new ValidationError(`${fieldName} must be a string`);
    }

    if (this.maxLength !== null && value.length > this.maxLength) {
      throw new ValidationError(`${fieldName} must be shorter than ${this.maxLength} characters`);
    }

    if (this.minLength !== null && value.length < this.minLength) {
      throw new ValidationError(`${fieldName} must be longer than ${this.minLength} characters`);
    }

    if (this.enumValues && !this.enumValues.includes(value)) {
      throw new ValidationError(`${fieldName} must be one of: ${this.enumValues.join(', ')}`);
    }

    this.runValidators(value, fieldName);
    return value as TypeOutput<string, TRequired>;
  }
}

/**
 * Number type definition with optional range/integer constraints.
 */
export class NumberType<TRequired extends boolean = false> extends Type<number, TRequired> {
  minValue: number | null;
  maxValue: number | null;
  isInteger: boolean;

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.minValue = null;
    this.maxValue = null;
    this.isInteger = false;
  }

  min(value: number): this {
    this.minValue = value;
    return this;
  }

  max(value: number): this {
    this.maxValue = value;
    return this;
  }

  integer(): this {
    this.isInteger = true;
    return this;
  }

  override required<T extends boolean = true>(isRequired = true as T): NumberType<T> {
    super.required(isRequired);
    return this as unknown as NumberType<T>;
  }

  override validate(value: unknown, fieldName = 'field'): TypeOutput<number, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<number, TRequired>;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(`${fieldName} must be a finite number`);
    }

    if (this.isInteger && !Number.isInteger(value)) {
      throw new ValidationError(`${fieldName} must be an integer`);
    }

    if (this.minValue !== null && value < this.minValue) {
      throw new ValidationError(`${fieldName} must be greater than or equal to ${this.minValue}`);
    }

    if (this.maxValue !== null && value > this.maxValue) {
      throw new ValidationError(`${fieldName} must be less than or equal to ${this.maxValue}`);
    }

    this.runValidators(value, fieldName);
    return value as TypeOutput<number, TRequired>;
  }
}

/**
 * Boolean type definition.
 */
export class BooleanType<TRequired extends boolean = false> extends Type<boolean, TRequired> {
  override required<T extends boolean = true>(isRequired = true as T): BooleanType<T> {
    super.required(isRequired);
    return this as unknown as BooleanType<T>;
  }

  override validate(value: unknown, fieldName = 'field'): TypeOutput<boolean, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<boolean, TRequired>;
    }

    if (typeof value !== 'boolean') {
      throw new ValidationError(`${fieldName} must be a boolean`);
    }

    this.runValidators(value, fieldName);
    return value as TypeOutput<boolean, TRequired>;
  }
}

/**
 * Date type definition with ISO parsing support.
 */
export class DateType<TRequired extends boolean = false> extends Type<Date, TRequired> {
  override required<T extends boolean = true>(isRequired = true as T): DateType<T> {
    super.required(isRequired);
    return this as unknown as DateType<T>;
  }

  override validate(value: unknown, fieldName = 'field'): TypeOutput<Date, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<Date, TRequired>;
    }

    let normalized: Date;

    if (value instanceof Date) {
      normalized = value;
    } else if (typeof value === 'string') {
      normalized = new Date(value);
    } else {
      throw new ValidationError(`${fieldName} must be a Date object`);
    }

    if (Number.isNaN(normalized.getTime())) {
      throw new ValidationError(`${fieldName} must be a valid date`);
    }

    this.runValidators(normalized, fieldName);
    return normalized as TypeOutput<Date, TRequired>;
  }
}

/**
 * Array type definition that can optionally enforce an element type.
 */
export class ArrayType<
  TElementField extends SchemaFieldLike = Type<unknown>,
  TRequired extends boolean = false,
> extends Type<Array<InferFieldValue<TElementField>>, TRequired> {
  elementType: TElementField | null;

  constructor(elementType: TElementField | null = null, options: Record<string, unknown> = {}) {
    super(options);
    this.elementType = elementType;
  }

  override required<T extends boolean = true>(isRequired = true as T): ArrayType<TElementField, T> {
    super.required(isRequired);
    return this as unknown as ArrayType<TElementField, T>;
  }

  override validate(
    value: unknown,
    fieldName = 'field'
  ): TypeOutput<Array<InferFieldValue<TElementField>>, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<Array<InferFieldValue<TElementField>>, TRequired>;
    }

    if (!Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an array`);
    }

    this.runValidators(value as Array<InferFieldValue<TElementField>>, fieldName);

    if (!this.elementType) {
      return value as TypeOutput<Array<InferFieldValue<TElementField>>, TRequired>;
    }

    const elementType = this.elementType;
    const normalized = value.map((item, index) =>
      elementType.validate(item, `${fieldName}[${index}]`)
    );

    return normalized as TypeOutput<Array<InferFieldValue<TElementField>>, TRequired>;
  }
}

/**
 * Object/JSONB type definition.
 *
 * @typeParam TValue - The type of values in the record (default: unknown)
 * @typeParam TRequired - Whether the field is required
 */
export class ObjectType<TValue = unknown, TRequired extends boolean = false> extends Type<
  Record<string, TValue>,
  TRequired
> {
  override required<T extends boolean = true>(isRequired = true as T): ObjectType<TValue, T> {
    super.required(isRequired);
    return this as unknown as ObjectType<TValue, T>;
  }

  override validate(
    value: unknown,
    fieldName = 'field'
  ): TypeOutput<Record<string, TValue>, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<Record<string, TValue>, TRequired>;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an object`);
    }

    this.runValidators(value as Record<string, TValue>, fieldName);
    return value as TypeOutput<Record<string, TValue>, TRequired>;
  }
}

/**
 * Virtual/computed field type definition.
 */
export class VirtualType<TValue = unknown, TRequired extends boolean = false> extends Type<
  TValue,
  TRequired
> {
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.isVirtual = true;
  }

  override required<T extends boolean = true>(isRequired = true as T): VirtualType<TValue, T> {
    super.required(isRequired);
    return this as unknown as VirtualType<TValue, T>;
  }

  returns<TNewValue>(): VirtualType<TNewValue, TRequired> {
    return this as unknown as VirtualType<TNewValue, TRequired>;
  }

  override validate(value: unknown, fieldName = 'field'): TypeOutput<TValue, TRequired> {
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    if (value === null || value === undefined) {
      return value as TypeOutput<TValue, TRequired>;
    }

    this.runValidators(value as TValue, fieldName);
    return value as TypeOutput<TValue, TRequired>;
  }
}

// Factory helpers used by manifests.
const types = {
  string: (options?: Record<string, unknown>) => new StringType(options),
  number: (options?: Record<string, unknown>) => new NumberType(options),
  boolean: (options?: Record<string, unknown>) => new BooleanType(options),
  date: (options?: Record<string, unknown>) => new DateType(options),
  array: <TElementField extends SchemaFieldLike = Type<unknown>>(
    elementType?: TElementField | null,
    options?: Record<string, unknown>
  ) => new ArrayType(elementType ?? null, options),
  object: (options?: Record<string, unknown>) => new ObjectType(options),
  virtual: <TValue = unknown>(options?: Record<string, unknown>) =>
    new VirtualType<TValue>(options),

  // Compatibility alias for unconstrained fields.
  any: (options?: Record<string, unknown>) => new Type<unknown>(options),
} as const;

export default types;
