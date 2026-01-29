import type { AppLocals, RequestUser, SessionDataWithFlash } from './http/locals.ts';

/**
 * Express augmentations wiring our custom request user and locals into the
 * framework types.
 */
declare global {
  namespace Express {
    /** Authenticated user object exposed by Passport (UserInstance + web fields). */
    interface User extends RequestUser {}

    interface Request {
      dal?: import('rev-dal').DalContext;
      locale: string;
      language?: LibReviews.LocaleCodeWithUndetermined;
      localeChange?: {
        old: LibReviews.LocaleCodeWithUndetermined;
        new: LibReviews.LocaleCodeWithUndetermined;
      };
      isAPI?: boolean;
      flash(key: string, value?: string | string[]): string[];
      flashHas?(key: string): boolean;
      flashError?(error: unknown): void;
      csrfToken?(): string;
      permissions?: Record<LibReviews.PermissionFlag | string, boolean>;
    }

    /** Response locals used by templates and render helpers. */
    interface Response {
      locals: Locals;
    }

    interface Locals extends AppLocals {}
  }
}

declare module 'express-session' {
  /** Session data extended with our flash buckets. */
  interface SessionData extends SessionDataWithFlash {}
}
