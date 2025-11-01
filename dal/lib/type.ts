import { ValidationError } from './errors.js';

export type ValidatorFunction = (value: unknown) => boolean | void;

/**
 * Base type class
 */
export class Type {
  options: Record<string, unknown>;
  validators: ValidatorFunction[];
  protected _required: boolean;
  defaultValue: unknown;
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
   * Add a validator function
   * @param validator - Validation function
   * @returns This instance for chaining
   */
  validator(validator: ValidatorFunction): this {
    if (typeof validator === 'function') {
      this.validators.push(validator);
    }
    return this;
  }

  /**
   * Mark field as required
   * @param isRequired - Whether field is required
   * @returns This instance for chaining
   */
  required(isRequired = true): this {
    this._required = isRequired;
    return this;
  }

  /**
   * Set default value
   * @param value - Default value or function
   * @returns This instance for chaining
   */
  default(value: unknown): this {
    this.defaultValue = value;
    this.hasDefault = true;
    return this;
  }

  /**
   * Mark field as sensitive (e.g., passwords, tokens)
   * Sensitive fields are excluded from joins and other operations by default
   * @param isSensitive - Whether field contains sensitive data
   * @returns This instance for chaining
   */
  sensitive(isSensitive = true): this {
    this.isSensitive = isSensitive;
    return this;
  }

  /**
   * Validate a value against this type
   * @param value - Value to validate
   * @param fieldName - Field name for error messages
   * @returns Validated value
   * @throws ValidationError If validation fails
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  validate(value: unknown, fieldName = 'field'): unknown {
    // Check required
    if (this._required && (value === null || value === undefined)) {
      throw new ValidationError(`${fieldName} is required`);
    }

    // Skip validation for null/undefined values if not required
    if (value === null || value === undefined) {
      return value;
    }

    // Run custom validators
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

    return value;
  }

  /**
   * Get the default value for this type
   * @returns Default value
   */
  getDefault(): unknown {
    if (!this.hasDefault) {
      return undefined;
    }

    if (typeof this.defaultValue === 'function') {
      return (this.defaultValue as () => unknown)();
    }

    return this.defaultValue;
  }
}

/**
 * String type
 */
export class StringType extends Type {
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
    this.validator((value) => {
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  uuid(_version = 4): this {
    this.validator((value) => {
      if (typeof value !== 'string') {
        throw new ValidationError('Must be a valid UUID');
      }
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        throw new ValidationError('Must be a valid UUID');
      }
      return true;
    });
    return this;
  }

  override validate(value: unknown, fieldName = 'field'): string | null | undefined {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue as null | undefined;
    }

    if (typeof validatedValue !== 'string') {
      throw new ValidationError(`${fieldName} must be a string`);
    }

    if (this.maxLength !== null && validatedValue.length > this.maxLength) {
      throw new ValidationError(`${fieldName} must be shorter than ${this.maxLength} characters`);
    }

    if (this.minLength !== null && validatedValue.length < this.minLength) {
      throw new ValidationError(`${fieldName} must be longer than ${this.minLength} characters`);
    }

    if (this.enumValues && !this.enumValues.includes(validatedValue)) {
      throw new ValidationError(`${fieldName} must be one of: ${this.enumValues.join(', ')}`);
    }

    return validatedValue;
  }
}

/**
 * Number type
 */
export class NumberType extends Type {
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

  override validate(value: unknown, fieldName = 'field'): number | null | undefined {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue as null | undefined;
    }

    if (typeof validatedValue !== 'number' || !Number.isFinite(validatedValue)) {
      throw new ValidationError(`${fieldName} must be a finite number`);
    }

    if (this.isInteger && !Number.isInteger(validatedValue)) {
      throw new ValidationError(`${fieldName} must be an integer`);
    }

    if (this.minValue !== null && validatedValue < this.minValue) {
      throw new ValidationError(`${fieldName} must be greater than or equal to ${this.minValue}`);
    }

    if (this.maxValue !== null && validatedValue > this.maxValue) {
      throw new ValidationError(`${fieldName} must be less than or equal to ${this.maxValue}`);
    }

    return validatedValue;
  }
}

/**
 * Boolean type
 */
export class BooleanType extends Type {
  override validate(value: unknown, fieldName = 'field'): boolean | null | undefined {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue as null | undefined;
    }

    if (typeof validatedValue !== 'boolean') {
      throw new ValidationError(`${fieldName} must be a boolean`);
    }

    return validatedValue;
  }
}

/**
 * Date type
 */
export class DateType extends Type {
  override validate(value: unknown, fieldName = 'field'): Date | null | undefined {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue as null | undefined;
    }

    if (validatedValue instanceof Date) {
      if (Number.isNaN(validatedValue.getTime())) {
        throw new ValidationError(`${fieldName} must be a valid date`);
      }
      return validatedValue;
    }

    if (typeof validatedValue === 'string') {
      const date = new Date(validatedValue);
      if (Number.isNaN(date.getTime())) {
        throw new ValidationError(`${fieldName} must be a valid date`);
      }
      return date;
    }

    throw new ValidationError(`${fieldName} must be a Date object`);
  }
}

/**
 * Array type
 */
export class ArrayType extends Type {
  elementType: Type | null;

  constructor(elementType: Type | null = null, options: Record<string, unknown> = {}) {
    super(options);
    this.elementType = elementType;
  }

  override validate(value: unknown, fieldName = 'field'): unknown {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue;
    }

    if (!Array.isArray(validatedValue)) {
      throw new ValidationError(`${fieldName} must be an array`);
    }

    if (this.elementType) {
      return validatedValue.map((item, index) => this.elementType!.validate(item, `${fieldName}[${index}]`));
    }

    return validatedValue;
  }
}

/**
 * Object type (for JSONB fields)
 */
export class ObjectType extends Type {
  override validate(value: unknown, fieldName = 'field'): Record<string, unknown> | null | undefined {
    const validatedValue = super.validate(value, fieldName);

    if (validatedValue === null || validatedValue === undefined) {
      return validatedValue as null | undefined;
    }

    if (typeof validatedValue !== 'object' || Array.isArray(validatedValue)) {
      throw new ValidationError(`${fieldName} must be an object`);
    }

    return validatedValue as Record<string, unknown>;
  }
}

/**
 * Virtual type (computed fields)
 */
export class VirtualType extends Type {
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    this.isVirtual = true;
  }

  override validate(value: unknown, fieldName = 'field'): unknown { // eslint-disable-line @typescript-eslint/no-unused-vars
    // Virtual fields are not validated during save
    return value;
  }
}

// Factory functions for creating type instances
const types = {
  string: (options?: Record<string, unknown>) => new StringType(options),
  number: (options?: Record<string, unknown>) => new NumberType(options),
  boolean: (options?: Record<string, unknown>) => new BooleanType(options),
  date: (options?: Record<string, unknown>) => new DateType(options),
  array: (elementType?: Type | null, options?: Record<string, unknown>) => new ArrayType(elementType ?? null, options),
  object: (options?: Record<string, unknown>) => new ObjectType(options),
  virtual: (options?: Record<string, unknown>) => new VirtualType(options),

  // Aliases for compatibility
  any: (options?: Record<string, unknown>) => new Type(options)
} as const;

export { types };

export default types;
