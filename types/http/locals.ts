import type { ViteDevServer } from 'vite';
import type { DalContext } from '../../dal/index.ts';
import type { DataAccessLayer, ModelInstance } from '../../dal/lib/model-types.ts';
import type { UserViewer } from '../../models/user.ts';
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

/**
 * Extension of `UserViewer` that includes web-only fields exposed on
 * `req.user` by authentication middleware (see `app.ts` and `models/user.ts`).
 */
export interface RequestUser extends UserViewer {
  displayName?: string;
  urlName?: string;
  email?: string;
  userCanUploadTempFiles?: boolean;
  inviteLinkCount?: number;
  suppressedNotices?: string[];
  prefersRichTextEditor?: boolean;
  showErrorDetails?: boolean;
  teams?: Array<Record<string, unknown>>;
  moderatorOf?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown> & { newRevision?: (...args: unknown[]) => Promise<unknown> };
  populateUserInfo?: (...args: unknown[]) => unknown;
  save?: () => Promise<RequestUser | ModelInstance | void>;
  getValidPreferences: () => string[];
  [key: string]: unknown;
}

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
}
