/**
 * Error classes for the PostgreSQL DAL
 *
 * Provides custom error types for database operations.
 */

/**
 * Base DAL error class
 */
class DALError extends Error {
  constructor(message, code = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Document not found error
 */
class DocumentNotFound extends DALError {
  constructor(message = 'Document not found') {
    super(message, 'DOCUMENT_NOT_FOUND');
    this.name = 'DocumentNotFound';
  }
}

/**
 * Invalid UUID error - for malformed UUID strings
 */
class InvalidUUIDError extends DALError {
  constructor(message = 'Invalid UUID format') {
    super(message, 'INVALID_UUID');
    this.name = 'InvalidUUIDError';
  }
}

/**
 * Validation error
 */
class ValidationError extends DALError {
  constructor(message, field = null) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Connection error
 */
class ConnectionError extends DALError {
  constructor(message = 'Database connection error') {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

/**
 * Transaction error
 */
class TransactionError extends DALError {
  constructor(message = 'Transaction error') {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

/**
 * Query error
 */
class QueryError extends DALError {
  constructor(message, originalError = null) {
    super(message, 'QUERY_ERROR');
    this.name = 'QueryError';
    this.originalError = originalError;
  }
}

/**
 * Constraint violation error
 */
class ConstraintError extends DALError {
  constructor(message, constraint = null) {
    super(message, 'CONSTRAINT_ERROR');
    this.name = 'ConstraintError';
    this.constraint = constraint;
  }
}

/**
 * Duplicate slug name error
 * 
 * Business logic error thrown when attempting to save a slug that already exists.
 * This abstracts away the database-specific ConstraintError to provide a semantic
 * error that application code can handle without knowing about constraint names.
 */
class DuplicateSlugNameError extends DALError {
  constructor(message, slugName = null, tableName = null) {
    super(message, 'DUPLICATE_SLUG');
    this.name = 'DuplicateSlugNameError';
    this.payload = {
      slug: {
        name: slugName
      }
    };
    this.tableName = tableName;
  }
}

/**
 * Convert PostgreSQL errors to DAL errors
 * @param {Error} pgError - PostgreSQL error
 * @returns {DALError} Converted DAL error
 */
function convertPostgreSQLError(pgError) {
  if (!pgError) {
    return new DALError('Unknown error');
  }

  // PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
  switch (pgError.code) {
    case '23505': // unique_violation
      return new ConstraintError(
        `Unique constraint violation: ${pgError.detail || pgError.message}`,
        pgError.constraint
      );
    
    case '23503': // foreign_key_violation
      return new ConstraintError(
        `Foreign key constraint violation: ${pgError.detail || pgError.message}`,
        pgError.constraint
      );
    
    case '23502': // not_null_violation
      return new ValidationError(
        `Not null constraint violation: ${pgError.column || pgError.message}`,
        pgError.column
      );
    
    case '23514': // check_violation
      return new ValidationError(
        `Check constraint violation: ${pgError.detail || pgError.message}`,
        pgError.constraint
      );
    
    case '08000': // connection_exception
    case '08003': // connection_does_not_exist
    case '08006': // connection_failure
      return new ConnectionError(pgError.message);
    
    case '42P01': // undefined_table
      return new QueryError(`Table does not exist: ${pgError.message}`, pgError);
    
    case '42703': // undefined_column
      return new QueryError(`Column does not exist: ${pgError.message}`, pgError);
    
    default:
      // For unknown errors, wrap in a generic QueryError
      return new QueryError(pgError.message, pgError);
  }
}

const errors = {
  DALError,
  DocumentNotFound,
  InvalidUUIDError,
  ValidationError,
  ConnectionError,
  TransactionError,
  QueryError,
  ConstraintError,
  DuplicateSlugNameError,
  convertPostgreSQLError
};

export {
  DALError,
  DocumentNotFound,
  InvalidUUIDError,
  ValidationError,
  ConnectionError,
  TransactionError,
  QueryError,
  ConstraintError,
  DuplicateSlugNameError,
  convertPostgreSQLError,
  errors as default
};
