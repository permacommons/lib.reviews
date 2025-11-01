import type { Debugger } from 'debug';
import type { Request } from 'express';

export interface DebugErrorContext {
  req?: Request | { route?: { path?: string }; method?: string; originalUrl?: string; body?: unknown };
  error?: Error;
}

export interface DebugLoggerMap {
  db: Debugger;
  app: Debugger;
  util: Debugger;
  tests: Debugger;
  adapters: Debugger;
  webhooks: Debugger;
  errorLog: Debugger;
  error(error: string | DebugErrorContext): void;
}

export function sanitizeForLogging<T>(value: T): T;

declare const debug: DebugLoggerMap;
export default debug;
