import type { AppLocals, RequestUser, SessionDataWithFlash } from './http/locals.ts';

declare global {
  namespace Express {
    interface User extends RequestUser {}

    interface Request {
      dal?: import('../dal/index.js').DalContext;
      locale?: LibReviews.LocaleCode;
      language?: LibReviews.LocaleCodeWithUndetermined;
      localeChange?: { old: LibReviews.LocaleCodeWithUndetermined; new: LibReviews.LocaleCodeWithUndetermined };
      isAPI?: boolean;
      flash(key: string, value?: string | string[]): string[];
      flashHas?(key: string): boolean;
      flashError?(error: unknown): void;
      csrfToken?(): string;
      permissions?: Record<LibReviews.PermissionFlag | string, boolean>;
      __?(message: string | { phrase: string; locale?: string }, ...args: unknown[]): string;
      __n?(...args: unknown[]): string;
    }

    interface Response {
      locals: Locals;
      __?(message: string | { phrase: string; locale?: string }, ...args: unknown[]): string;
      __n?(...args: unknown[]): string;
    }

    interface Locals extends AppLocals {}
  }
}

declare module 'express-session' {
  interface SessionData extends SessionDataWithFlash {}
}
