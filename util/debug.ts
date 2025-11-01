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
export interface DebugLoggerMap {
  db: Debugger;
  app: Debugger;
  util: Debugger;
  tests: Debugger;
  adapters: Debugger;
  webhooks: Debugger;
  errorLog: Debugger;
  /** Logs either a raw string or a structured error payload. */
  error(this: DebugLoggerMap, error: string | DebugErrorContext): void;
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
const debug: DebugLoggerMap = {
  // For lower-level debug messages available if needed
  db: debugModule('libreviews:db'),
  app: debugModule('libreviews:app'),
  util: debugModule('libreviews:util'),
  tests: debugModule('libreviews:tests'),
  adapters: debugModule('libreviews:adapters'),
  webhooks: debugModule('libreviews:webhooks'),
  errorLog: debugModule('libreviews:error'), // for property access, use debug.error for logging

  error(this: DebugLoggerMap, error: string | DebugErrorContext): void {
    if (typeof error === 'string') {
      this.errorLog(error);
      return;
    }

    const log = this.errorLog;
    const request = error?.req;

    if (request) {
      if (request.route && 'path' in request.route && request.route.path)
        log(`Error occurred in route <${request.route.path}>.`);

      if (request.method || request.originalUrl)
        log(`Request method: ${request.method ?? 'UNKNOWN'} - URL: ${request.originalUrl ?? 'UNKNOWN'}`);

      if (request.method !== 'GET' && request.body !== undefined) {
        log('Request body:');
        if (typeof request.body === 'object') {
          log(JSON.stringify(sanitizeForLogging(request.body), null, 2));
        } else {
          log('<omitted>');
        }
      }
    }

    if (error?.error) {
      log('Stacktrace:');
      log(error.error.stack ?? String(error.error));
    }
  }
};

export default debug;
export { sanitizeForLogging };
