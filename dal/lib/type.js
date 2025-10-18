'use strict';

/**
 * Type system for PostgreSQL DAL
 * 
 * Provides type definitions and validation that are compatible with
 * the existing Thinky type system, allowing for seamless migration
 * of existing model definitions.
 */

const { ValidationError } = require('./errors');

/**
 * Base type class
 */
class Type {
  constructor(options = {}) {
    this.options = options;
    this.validators = [];
    this._required = false;
    this.defaultValue = undefined;
    this.hasDefault = false;
  }

  /**
   * Add a validator function
   * @param {Function} validator - Validation function
   * @returns {Type} This instance for chaining
   */
  validator(validator) {
    if (typeof validator === 'function') {
      this.validators.push(validator);
    }
    return this;
  }

  /**
   * Mark field as required
   * @param {boolean} isRequired - Whether field is required
   * @returns {Type} This instance for chaining
   */
  required(isRequired = true) {
    this._required = isRequired;
    return this;
  }

  /**
   * Set default value
   * @param {*} value - Default value or function
   * @returns {Type} This instance for chaining
   */
  default(value) {
    this.defaultValue = value;
    this.hasDefault = true;
    return this;
  }

  /**
   * Validate a value against this type
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error messages
   * @returns {*} Validated value
   * @throws {ValidationError} If validation fails
   */
  validate(value, fieldName = 'field') {
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
        throw new ValidationError(`Validation error for ${fieldName}: ${error.message}`);
      }
    }

    return value;
  }

  /**
   * Get the default value for this type
   * @returns {*} Default value
   */
  getDefault() {
    if (!this.hasDefault) {
      return undefined;
    }
    
    if (typeof this.defaultValue === 'function') {
      return this.defaultValue();
    }
    
    return this.defaultValue;
  }
}

/**
 * String type
 */
class StringType extends Type {
  constructor(options = {}) {
    super(options);
    this.maxLength = null;
    this.minLength = null;
    this.enumValues = null;
  }

  max(length) {
    this.maxLength = length;
    return this;
  }

  min(length) {
    this.minLength = length;
    return this;
  }

  enum(values) {
    this.enumValues = Array.isArray(values) ? values : [values];
    return this;
  }

  email() {
    this.validator((value) => {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        throw new ValidationError('Must be a valid email address');
      }
      return true;
    });
    return this;
  }

  uuid(version = 4) {
    this.validator((value) => {
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(value)) {
        throw new ValidationError('Must be a valid UUID');
      }
      return true;
    });
    return this;
  }

  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
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

    return value;
  }
}

/**
 * Number type
 */
class NumberType extends Type {
  constructor(options = {}) {
    super(options);
    this.minValue = null;
    this.maxValue = null;
    this.isInteger = false;
  }

  min(value) {
    this.minValue = value;
    return this;
  }

  max(value) {
    this.maxValue = value;
    return this;
  }

  integer() {
    this.isInteger = true;
    return this;
  }

  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'number' || !isFinite(value)) {
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

    return value;
  }
}

/**
 * Boolean type
 */
class BooleanType extends Type {
  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'boolean') {
      throw new ValidationError(`${fieldName} must be a boolean`);
    }

    return value;
  }
}

/**
 * Date type
 */
class DateType extends Type {
  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
    }

    if (!(value instanceof Date)) {
      // Try to convert string to date
      if (typeof value === 'string') {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new ValidationError(`${fieldName} must be a valid date`);
        }
        return date;
      }
      throw new ValidationError(`${fieldName} must be a Date object`);
    }

    if (isNaN(value.getTime())) {
      throw new ValidationError(`${fieldName} must be a valid date`);
    }

    return value;
  }
}

/**
 * Array type
 */
class ArrayType extends Type {
  constructor(elementType = null, options = {}) {
    super(options);
    this.elementType = elementType;
  }

  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
    }

    if (!Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an array`);
    }

    // Validate each element if element type is specified
    if (this.elementType) {
      return value.map((item, index) => {
        return this.elementType.validate(item, `${fieldName}[${index}]`);
      });
    }

    return value;
  }
}

/**
 * Object type (for JSONB fields)
 */
class ObjectType extends Type {
  validate(value, fieldName = 'field') {
    value = super.validate(value, fieldName);
    
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError(`${fieldName} must be an object`);
    }

    return value;
  }
}

/**
 * Virtual type (computed fields)
 */
class VirtualType extends Type {
  constructor(options = {}) {
    super(options);
    this.isVirtual = true;
  }

  validate(value, fieldName = 'field') {
    // Virtual fields are not validated during save
    return value;
  }
}

// Factory functions to match Thinky API
const type = {
  string: (options) => new StringType(options),
  number: (options) => new NumberType(options),
  boolean: (options) => new BooleanType(options),
  date: (options) => new DateType(options),
  array: (elementType, options) => new ArrayType(elementType, options),
  object: (options) => new ObjectType(options),
  virtual: (options) => new VirtualType(options),
  
  // Aliases for compatibility
  any: (options) => new Type(options)
};

module.exports = type;