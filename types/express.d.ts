import type WebHookDispatcher from '../util/webhooks.ts';
import type { ViteDevServer } from 'vite';

declare global {
  namespace Express {
    interface Request {
      dal?: import('../dal/index.js').DalContext;
      locale?: LibReviews.LocaleCode;
      localeChange?: { old: LibReviews.LocaleCode | 'und'; new: LibReviews.LocaleCode | 'und' };
      isAPI?: boolean;
      flash(key: string, value?: string | string[]): string[];
      flashHas?(key: string): boolean;
      flashError?(error: unknown): void;
      csrfToken?(): string;
      permissions?: Record<LibReviews.PermissionFlag | string, boolean>;
    }

    interface Response {
      locals: Locals;
      __?(message: string, ...args: unknown[]): string;
      __n?(...args: unknown[]): string;
    }

    interface Locals {
      dal?: import('../dal/index.js').DalContext;
      webHooks?: WebHookDispatcher;
      vite?: ViteDevServer;
      titleKey?: string;
      locale?: LibReviews.LocaleCode;
      permissions?: Record<LibReviews.PermissionFlag | string, boolean>;
      [key: string]: unknown;
    }
  }
}
