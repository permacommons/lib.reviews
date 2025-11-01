import type { Debugger } from 'debug';
import debugModule from 'debug';
import type { Request } from 'express';

/** Keys that are stripped or redacted when logging request payloads. */
const SENSITIVE_LOG_KEYS = new Set<string>([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken'
]);

type SerializableObject = Record<string, unknown>;

type RequestLike = Pick<Request, 'method' | 'originalUrl' | 'body' | 'route'> | {
  route?: { path?: string };
  method?: string;
  originalUrl?: string;
  body?: unknown;
};

/**
 * Shape for structured error logging that mirrors the legacy `debug` helper.
 */
export interface DebugErrorContext {
  req?: RequestLike;
  error?: Error & { stack?: string };
}

/** Mapping of debug channels available to the application. */
export type DebugErrorDetail = DebugErrorContext | Error | string | null | undefined;

export interface DebugLoggerMap {
  db: Debugger;
  app: Debugger;
  util: Debugger;
  tests: Debugger;
  adapters: Debugger;
  webhooks: Debugger;
  errorLog: Debugger;
  /** Logs either a raw string or a structured error payload. */
  error: DebugErrorFunction;
}

export interface DebugErrorFunction {
  (this: DebugLoggerMap, message: string, detail?: DebugErrorDetail): void;
  (this: DebugLoggerMap, detail: DebugErrorDetail): void;
}

/**
 * Recursively redacts credentials and nested secrets before serializing the
 * object to JSON for debugging. Primitive values are returned unchanged.
 */
function sanitizeForLogging<T>(value: T): T {
  if (value === null || typeof value !== 'object')
    return value;

  if (Array.isArray(value))
    return value.map(item => sanitizeForLogging(item)) as unknown as T;

  const sanitized: SerializableObject = {};

  for (const [key, val] of Object.entries(value as SerializableObject)) {
    if (SENSITIVE_LOG_KEYS.has(key)) {
      sanitized[key] = '<redacted>';
    } else {
      sanitized[key] = sanitizeForLogging(val);
    }
  }

  return sanitized as T;
}

/**
 * Singleton wrapper around the `debug` package that exposes the same channel
 * names we used in CommonJS, plus helpers for structured error reporting.
 */
const logDetail = (logger: Debugger, detail: DebugErrorDetail): void => {
  if (!detail) {
    return;
  }

  if (typeof detail === 'string') {
    logger(detail);
    return;
  }

  if (detail instanceof Error) {
    logger('Stacktrace:');
    logger(detail.stack ?? String(detail));
    return;
  }

  const request = detail.req;

  if (request) {
    if (request.route && 'path' in request.route && request.route.path)
      logger(`Error occurred in route <${request.route.path}>.`);

    if (request.method || request.originalUrl)
      logger(`Request method: ${request.method ?? 'UNKNOWN'} - URL: ${request.originalUrl ?? 'UNKNOWN'}`);

    if (request.method !== 'GET' && request.body !== undefined) {
      logger('Request body:');
      if (typeof request.body === 'object') {
        logger(JSON.stringify(sanitizeForLogging(request.body), null, 2));
      } else {
        logger('<omitted>');
      }
    }
  }

  if (detail.error) {
    logger('Stacktrace:');
    logger(detail.error.stack ?? String(detail.error));
  }
};

const debug: DebugLoggerMap = {
  // For lower-level debug messages available if needed
  db: debugModule('libreviews:db'),
  app: debugModule('libreviews:app'),
  util: debugModule('libreviews:util'),
  tests: debugModule('libreviews:tests'),
  adapters: debugModule('libreviews:adapters'),
  webhooks: debugModule('libreviews:webhooks'),
  errorLog: debugModule('libreviews:error'), // for property access, use debug.error for logging

  error(this: DebugLoggerMap, first: string | DebugErrorDetail, maybeDetail?: DebugErrorDetail): void {
    const log = this.errorLog;

    if (typeof first === 'string') {
      log(first);
      if (maybeDetail !== undefined) {
        logDetail(log, maybeDetail);
      }
      return;
    }

    logDetail(log, first);
  }
};

export default debug;
export { sanitizeForLogging };
