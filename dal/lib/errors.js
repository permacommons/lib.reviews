'use strict';

/**
 * Error classes for the PostgreSQL DAL
 * 
 * Provides custom error types that match the interface expected by
 * the existing application code, maintaining compatibility with
 * the RethinkDB/Thinky error handling.
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
 * Document not found error - equivalent to Thinky's DocumentNotFound
 */
class DocumentNotFound extends DALError {
  constructor(message = 'Document not found') {
    super(message, 'DOCUMENT_NOT_FOUND');
    this.name = 'DocumentNotFound';
  }
}

/**
 * Validation error - equivalent to Thinky's ValidationError
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

module.exports = {
  DALError,
  DocumentNotFound,
  ValidationError,
  ConnectionError,
  TransactionError,
  QueryError,
  ConstraintError,
  convertPostgreSQLError
};
