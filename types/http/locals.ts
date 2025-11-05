import type WebHookDispatcher from '../../util/webhooks.ts';
import type { ViteDevServer } from 'vite';

import type { DalContext } from '../../dal/index.ts';
import type { DataAccessLayer } from '../../dal/lib/model-types.ts';

type LocaleCode = LibReviews.LocaleCode;
type LocaleCodeWithUndetermined = LibReviews.LocaleCodeWithUndetermined;
type PermissionFlag = LibReviews.PermissionFlag;

export interface FlashBuckets {
  pageErrors?: string[];
  pageMessages?: string[];
  siteErrors?: string[];
  siteMessages?: string[];
  [key: string]: string[] | undefined;
}

export interface SessionDataWithFlash {
  flash?: FlashBuckets;
  returnTo?: string;
  [key: string]: unknown;
}

export interface RequestUser {
  id: string | number;
  displayName?: string;
  urlName?: string;
  email?: string;
  isTrusted?: boolean;
  isSuperUser?: boolean;
  isSiteModerator?: boolean;
  userCanUploadTempFiles?: boolean;
  inviteLinkCount?: number;
  suppressedNotices?: string[];
  prefersRichTextEditor?: boolean;
  showErrorDetails?: boolean;
  teams?: Array<Record<string, unknown>>;
  moderatorOf?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown> & { newRevision?: (...args: unknown[]) => Promise<unknown> };
  populateUserInfo?: (...args: unknown[]) => unknown;
  save?: () => Promise<RequestUser | void>;
  getValidPreferences: () => string[];
  [key: string]: unknown;
}

export interface AppLocals {
  dal?: DalContext | DataAccessLayer;
  webHooks?: WebHookDispatcher;
  vite?: ViteDevServer;
  titleKey?: string;
  locale?: LocaleCode;
  permissions?: Record<PermissionFlag | string, boolean>;
  [key: string]: unknown;
}

export interface TemplateLanguageName {
  langKey: LocaleCode;
  name: string;
  isCurrentLanguage?: boolean;
}

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
