/**
 * Error classes for the PostgreSQL DAL
 *
 * Provides custom error types for database operations.
 */

export interface PostgresError extends Error {
  code?: string;
  detail?: string;
  constraint?: string;
  column?: string;
}

/**
 * Base DAL error class
 */
export class DALError extends Error {
  code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/**
 * Document not found error
 */
export class DocumentNotFound extends DALError {
  constructor(message = 'Document not found') {
    super(message, 'DOCUMENT_NOT_FOUND');
    this.name = 'DocumentNotFound';
  }
}

/**
 * Invalid UUID error - for malformed UUID strings
 */
export class InvalidUUIDError extends DALError {
  constructor(message = 'Invalid UUID format') {
    super(message, 'INVALID_UUID');
    this.name = 'InvalidUUIDError';
  }
}

/**
 * Validation error
 */
export class ValidationError extends DALError {
  field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Connection error
 */
export class ConnectionError extends DALError {
  constructor(message = 'Database connection error') {
    super(message, 'CONNECTION_ERROR');
    this.name = 'ConnectionError';
  }
}

/**
 * Transaction error
 */
export class TransactionError extends DALError {
  constructor(message = 'Transaction error') {
    super(message, 'TRANSACTION_ERROR');
    this.name = 'TransactionError';
  }
}

/**
 * Query error
 */
export class QueryError extends DALError {
  originalError: unknown;

  constructor(message: string, originalError: unknown = null) {
    super(message, 'QUERY_ERROR');
    this.name = 'QueryError';
    this.originalError = originalError;
  }
}

/**
 * Constraint violation error
 */
export class ConstraintError extends DALError {
  constraint: string | null;

  constructor(message: string, constraint: string | null = null) {
    super(message, 'CONSTRAINT_ERROR');
    this.name = 'ConstraintError';
    this.constraint = constraint;
  }
}

export interface DuplicateSlugPayload {
  slug: {
    name: string | null;
  };
}

/**
 * Duplicate slug name error
 *
 * Business logic error thrown when attempting to save a slug that already exists.
 * This abstracts away the database-specific ConstraintError to provide a semantic
 * error that application code can handle without knowing about constraint names.
 */
export class DuplicateSlugNameError extends DALError {
  payload: DuplicateSlugPayload;
  tableName: string | null;

  constructor(message: string, slugName: string | null = null, tableName: string | null = null) {
    super(message, 'DUPLICATE_SLUG');
    this.name = 'DuplicateSlugNameError';
    this.payload = {
      slug: {
        name: slugName,
      },
    };
    this.tableName = tableName;
  }
}

/**
 * Convert PostgreSQL errors to DAL errors
 * @param pgError - PostgreSQL error
 * @returns Converted DAL error
 */
export function convertPostgreSQLError(pgError: unknown): DALError {
  if (!pgError || typeof pgError !== 'object') {
    return new DALError('Unknown error');
  }

  const error = pgError as PostgresError & { [key: string]: unknown };
  const message = typeof error.message === 'string' ? error.message : 'Unknown error';

  // PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
  switch (error.code) {
    case '23505': // unique_violation
      return new ConstraintError(
        `Unique constraint violation: ${error.detail ?? message}`,
        error.constraint ?? null
      );

    case '23503': // foreign_key_violation
      return new ConstraintError(
        `Foreign key constraint violation: ${error.detail ?? message}`,
        error.constraint ?? null
      );

    case '23502': // not_null_violation
      return new ValidationError(
        `Not null constraint violation: ${error.column ?? message}`,
        error.column ?? null
      );

    case '23514': // check_violation
      return new ValidationError(
        `Check constraint violation: ${error.detail ?? message}`,
        error.constraint ?? null
      );

    case '08000': // connection_exception
    case '08003': // connection_does_not_exist
    case '08006': // connection_failure
      return new ConnectionError(message);

    case '42P01': // undefined_table
      return new QueryError(`Table does not exist: ${message}`, error);

    case '42703': // undefined_column
      return new QueryError(`Column does not exist: ${message}`, error);

    default:
      // For unknown errors, wrap in a generic QueryError
      return new QueryError(message, error);
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
  convertPostgreSQLError,
} as const;

export default errors;
