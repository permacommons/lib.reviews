import type WebHookDispatcher from '../../util/webhooks.ts';
import type { ViteDevServer } from 'vite';

import type { DalContext } from '../../dal/index.js';
import type { DataAccessLayer } from '../../dal/lib/model-types.js';

type LocaleCode = LibReviews.LocaleCode;
type PermissionFlag = LibReviews.PermissionFlag;

export interface FlashBuckets {
  pageErrors?: string[];
  siteErrors?: string[];
  siteMessages?: string[];
  [key: string]: string[] | undefined;
}

export interface SessionDataWithFlash {
  flash?: FlashBuckets;
}

export interface RequestUser {
  id: number | string;
  displayName?: string;
  urlName?: string;
  isTrusted?: boolean;
  prefersRichTextEditor?: boolean;
  showErrorDetails?: boolean;
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
  localeChange?: { old: LocaleCode | 'und'; new: LocaleCode | 'und' };
  siteMessages?: string[];
  siteErrors?: string[];
}
