// External dependencies

import { parse as parseURL } from 'node:url';
import config from 'config';
import type { Request, Response } from 'express';
// Internal dependencies
import languages from '../../locales/languages.ts';
import type { TemplateContext, TemplateLanguageName } from '../../types/http/locals.ts';
import clientAssets from '../../util/client-assets.ts';

type LocaleCode = LibReviews.LocaleCode;

type ExtraVars = Partial<TemplateContext & { scripts?: string[]; viteManifest?: unknown }>;

type JsConfig = {
  userName?: string;
  userID?: string | number;
  isTrusted: boolean;
  language?: string;
  userPrefersRichTextEditor?: boolean;
  messages: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Render an hbs template with shared globals for scripts, localization, and
 * configuration. Accepts additional template variables and client-side config
 * exposed via `window.config`.
 *
 * @param req
 *  Request providing locale, session, and flash state
 * @param res
 *  Response used to render the view
 * @param view
 *  Template name under views/
 * @param extraVars
 *  Additional template variables to merge into the render context
 * @param extraJSConfig
 *  Extra client-side config injected into window.config (avoid sensitive data)
 */
const template = (
  req: Request,
  res: Response,
  view: string,
  extraVars: ExtraVars = {},
  extraJSConfig: Record<string, unknown> = {}
) => {
  const vars: TemplateContext = { ...(extraVars as TemplateContext) };

  const jsConfig: JsConfig = {
    userName: req.user?.displayName,
    userID: req.user?.id,
    isTrusted: Boolean(req.user?.isTrusted),
    language: req.locale,
    userPrefersRichTextEditor: req.user?.prefersRichTextEditor,
    messages: {},
    ...extraJSConfig,
  };

  const localeCode: LocaleCode = languages.isValid(req.locale) ? (req.locale as LocaleCode) : 'en';
  Object.assign(jsConfig.messages, languages.getCompositeNamesAsMessageObject(localeCode));
  const defaultMessages = ['show password', 'hide password'] as const;
  defaultMessages.forEach(key => {
    jsConfig.messages[key] = req.__(key);
  });

  vars.configScript = `window.config = ${JSON.stringify(jsConfig)};`;

  const requestedScripts: string[] = Array.isArray(extraVars.scripts) ? [...extraVars.scripts] : [];
  vars.user = req.user ?? undefined;

  const assets = clientAssets.getClientAssets(requestedScripts);
  vars.scripts = assets.scripts;
  vars.styles = assets.styles;

  if (process.env.NODE_ENV !== 'production')
    (vars as ExtraVars).viteManifest = clientAssets.getManifest();

  const sortedLanguages = languages.getValidLanguagesSorted();
  vars.languageNames = [];
  sortedLanguages.forEach(lang => {
    const langKey = lang as LocaleCode;
    const nameObj: TemplateLanguageName = {
      langKey,
      name: languages.getCompositeName(langKey, localeCode),
    };
    if (langKey === localeCode) nameObj.isCurrentLanguage = true;
    vars.languageNames.push(nameObj);
  });

  const currentLocale = localeCode;
  vars.currentLanguage = {
    langKey: currentLocale,
    name: languages.getNativeName(currentLocale),
  };

  if (req.csrfToken) vars.csrfToken = req.csrfToken();

  vars.qualifiedURL = config.qualifiedURL;
  vars.urlPath = parseURL(req.originalUrl).pathname ?? undefined;

  const registerRegex = /^\/register(\/|$)/;
  if (req.query.returnTo) vars.returnTo = String(req.query.returnTo);
  else if (req.path === '/signin' || registerRegex.test(req.path)) vars.returnTo = '/';
  else vars.returnTo = vars.urlPath;

  if (typeof req.localeChange === 'object' && req.localeChange?.old && req.localeChange?.new)
    vars.localeChange = req.localeChange;

  vars.siteMessages = req.flash('siteMessages');
  vars.siteErrors = req.flash('siteErrors');
  res.render(view, vars);
};

const signinRequired = (req: Request, res: Response, extraVars?: ExtraVars) => {
  template(req, res, 'signin-required', extraVars);
};

/**
 * Render a permission error page. Pass `detailsKey` in `extraVars` to surface
 * localized context about the denied permission.
 */
const permissionError = (req: Request, res: Response, extraVars?: ExtraVars) => {
  res.status(403);
  template(req, res, 'permission-error', extraVars);
};

/**
 * Render a generic resource error page. Provide `titleKey` and `bodyKey` in
 * `extraVars` to explain the issue (e.g., stale revision, missing page).
 */
const resourceError = (req: Request, res: Response, extraVars?: ExtraVars) => {
  template(req, res, 'resource-error', extraVars);
};

const render = {
  template,
  signinRequired,
  permissionError,
  resourceError,
};

export type RenderHelper = typeof render;
export default render;
