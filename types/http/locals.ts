import type { DalContext } from 'rev-dal';
import type { DataAccessLayer } from 'rev-dal/lib/model-types';
import type { ViteDevServer } from 'vite';
import type { UserInstance } from '../../models/user.ts';
import type WebHookDispatcher from '../../util/webhooks.ts';

type LocaleCode = LibReviews.LocaleCode;
type LocaleCodeWithUndetermined = LibReviews.LocaleCodeWithUndetermined;
type PermissionFlag = LibReviews.PermissionFlag;

/**
 * Buckets used by `flashStore` and `routes/helpers/render.ts` to surface site
 * and page-level flash messages.
 */
export interface FlashBuckets {
  pageErrors?: string[];
  pageMessages?: string[];
  siteErrors?: string[];
  siteMessages?: string[];
  [key: string]: string[] | undefined;
}

/** Session data augmented with the flash buckets created by `flashStore`. */
export interface SessionDataWithFlash {
  flash?: FlashBuckets;
  returnTo?: string;
  [key: string]: unknown;
}

type RequestUserWebFields = Partial<Pick<UserInstance, 'teams' | 'moderatorOf' | 'meta'>> & {
  permissions?: Record<PermissionFlag | string, boolean>;
};

/**
 * Authenticated user object exposed by Passport. Combines the DAL-derived
 * `UserInstance` shape with web-only enrichments populated during request
 * handling.
 */
export type RequestUser = UserInstance & RequestUserWebFields;

/**
 * Shared locals attached to both Express responses and Handlebars templates.
 * `app.ts` populates these entries so render helpers can reach the DAL, Vite,
 * and webhook dispatcher instances.
 */
export interface AppLocals {
  dal?: DalContext | DataAccessLayer;
  webHooks?: WebHookDispatcher;
  vite?: ViteDevServer;
  titleKey?: string;
  locale?: LocaleCode;
  permissions?: Record<PermissionFlag | string, boolean>;
  [key: string]: unknown;
}

/**
 * Language metadata injected into templates so the language picker can display
 * localized names (see `routes/helpers/render.ts`).
 */
export interface TemplateLanguageName {
  langKey: LocaleCode;
  name: string;
  isCurrentLanguage?: boolean;
}

/**
 * Full template context produced by `routes/helpers/render.ts` when rendering
 * views. Extends `AppLocals` with request-scoped data like the current user,
 * CSRF token, and asset lists.
 */
export interface TemplateContext extends AppLocals {
  user?: RequestUser | null;
  configScript?: string;
  scripts?: string[];
  styles?: string[];
  languageNames?: TemplateLanguageName[];
  currentLanguage?: { langKey: LocaleCode; name: string };
  csrfToken?: string;
  qualifiedURL?: string;
  urlPath?: string;
  returnTo?: string;
  localeChange?: { old: LocaleCodeWithUndetermined; new: LocaleCodeWithUndetermined };
  siteMessages?: string[];
  siteErrors?: string[];
  dataTheme?: 'light' | 'dark';
}
