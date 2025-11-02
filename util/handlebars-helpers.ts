// External dependencies
import type { HelperOptions } from 'handlebars';
import hbs from 'hbs';
import escapeHTML from 'escape-html';
import i18n from 'i18n';
import stripTags from 'striptags';
import linkifyHTML from 'linkify-html';

// Internal dependencies
import mlString from '../dal/lib/ml-string.js';
import languages from '../locales/languages.ts';
import type { LocaleCodeWithUndetermined } from '../locales/languages.ts';
import thingModelHandle from '../models/thing.js';
import urlUtils from './url-utils.ts';
import adapters from '../adapters/adapters.js';
import getLicenseURL from './get-license-url.ts';
import debug from './debug.ts';
import { formatLongDate, formatShortDate } from './date.ts';
import type { TemplateContext } from '../types/http/locals.ts';

type ThingLike = {
  label?: unknown;
  urls?: string[];
  urlID?: string;
};

type ThingModelHandle = {
  getLabel?: (thing: ThingLike, locale: string) => string | undefined;
};

const getTemplateContext = (options: HelperOptions): TemplateContext =>
  (options?.data?.root ?? {}) as TemplateContext;

const resolveMultilingual = (locale: string, value: unknown) =>
  mlString.resolve(locale, value as Record<string, string> | null | undefined);

/**
 * Resolve a thing's display label in the current locale, with safe fallbacks.
 *
 * @param thing
 *  Thing object or plain data used by the template
 * @param locale
 *  Active locale for rendering
 * @returns Localized label, prettified URL, or an empty string
 */
function getThingLabel(thing: ThingLike | null | undefined, locale: string): string {
  if (!thing) {
    return '';
  }

  const modelGetLabel = (thingModelHandle as ThingModelHandle | null | undefined)?.getLabel;

  if (typeof modelGetLabel === 'function') {
    try {
      const label = modelGetLabel(thing, locale);
      if (label) {
        return label;
      }
    } catch (err) {
      debug && debug.error && debug.error('Failed to resolve thing label via model handle', err);
    }
  }

  // Manual fallback mirrors Thing.getLabel behaviour without relying on the model
  let resolved;
  if (thing.label) {
    resolved = resolveMultilingual(locale, thing.label);
    if (resolved && resolved.str) {
      return resolved.str;
    }
  }

  if (thing.urls && thing.urls.length) {
    return urlUtils.prettify(thing.urls[0]);
  }

  return '';
}

// Current iteration value will be passed as {{this}} into the block,
// starts at 1 for more human-readable counts. First and last set @first, @last
hbs.registerHelper('times', function(this: unknown, n: number, block: HelperOptions) {
  let data: Record<string, unknown> = {};
  let rv = '';

  if (block.data)
    data = hbs.handlebars.createFrame(block.data);

  for (let i = 1; i <= n; i++) {
    data.zeroIndex = i - 1;
    data.first = i == 1 ? true : false;
    data.last = i == n ? true : false;
    rv += (block.fn?.(i, { data }) ?? '').trim();
  }
  return rv;
});

hbs.registerHelper('escapeHTML', function(this: unknown, block: HelperOptions) {
  return escapeHTML((block.fn?.(this) ?? '').toString());
});

hbs.registerHelper('link', function(url: string, title: string, singleQuotes?: boolean) {
  const q = singleQuotes ? "'" : '"';
  return `<a href=${q}${url}${q}>${title}</a>`;
});

// Strips HTML and shortens to specified length
hbs.registerHelper('summarize', function(html: string, length: number) {
  const stripped = stripTags(html ?? '');
  let shortened = stripped.substr(0, length);
  if (stripped.length > length)
    shortened += '...';
  return shortened;
});

hbs.registerHelper('userLink', userLink);

hbs.registerHelper('prettify', function(url?: string | null) {
  if (url)
    return urlUtils.prettify(url);
  else
    return '';
});

hbs.registerHelper('shortDate', function(date: Date | string | number) {
  return formatShortDate(date);
});

hbs.registerHelper('longDate', function(date: Date | string | number) {
  return formatLongDate(date);
});

// Sources are external sites we interface with; if they're known sources,
// they have a message key of this standard format.
hbs.registerHelper('getSourceMsgKey', function(sourceID) {
  return `${sourceID} source label`;
});

// Licensing notices for sources follow a similar pattern
hbs.registerHelper('getSourceLicensingKey', function(sourceID) {
  return `${sourceID} license`;
});

// Tags are used to classify sources into domains like "Databases"; these, too,
// have message keys.
hbs.registerHelper('getTagMsgKey', function(sourceID) {
  return `${sourceID} tag label`;
});


hbs.registerHelper('getSourceURL', function(sourceID) {
  return adapters.getSourceURL(sourceID);
});

hbs.registerHelper('__', function(...args: unknown[]) {
  const options = args.pop() as HelperOptions;
  return Reflect.apply(i18n.__, getTemplateContext(options), args);
});

hbs.registerHelper('__n', function(...args: unknown[]) {
  const options = args.pop() as HelperOptions;
  return Reflect.apply(i18n.__n, getTemplateContext(options), args);
});

// Get the language code that will result from resolving a string to the
// current request language (may be a fallback if no translation available).
hbs.registerHelper('getLang', function(str: unknown, options: HelperOptions) {
  const context = getTemplateContext(options);
  const mlRv = resolveMultilingual(context.locale, str);
  return mlRv ? mlRv.lang : undefined;
});

hbs.registerHelper('getThingLabel', (thing: ThingLike | null | undefined, options: HelperOptions) => {
  const context = getTemplateContext(options);
  return getThingLabel(thing, context.locale);
});

// Just a simple %1, %2 substitution function for various purposes
hbs.registerHelper('substitute', function(...args) {

  let i = 1,
    string = args.shift();

  while (args.length) {
    let sub = args.shift();
    string = string.replace(`%${i}`, sub);
    i++;
  }
  return string;
});

hbs.registerHelper('getThingLink', (thing: ThingLike | null | undefined, options: HelperOptions) => {
  if (!thing) {
    return '';
  }
  const context = getTemplateContext(options);
  const label = getThingLabel(thing, context.locale);
  return `<a href="/${thing.urlID ?? ''}">${label || ''}</a>`;
});

// Filenames cannot contain HTML metacharacters, so URL encoding is sufficient here
hbs.registerHelper('getFileLink', filename => `<a href="/static/uploads/${encodeURIComponent(filename)}">${filename}</a>`);

hbs.registerHelper('getLanguageName', (lang: string, options: HelperOptions) => {
  const context = getTemplateContext(options);
  const targetLanguage = lang as LocaleCodeWithUndetermined;
  const translationLocale = (context.locale ?? 'en') as LocaleCodeWithUndetermined;
  return languages.getTranslatedName(targetLanguage, translationLocale);
});

hbs.registerHelper('isoDate', (date: { toISOString?: () => string } | null | undefined) =>
  date && typeof date.toISOString === 'function' ? date.toISOString() : undefined
);

// Resolve a multilingual string to the current request language.
//
// addLanguageSpan -- Do we want a little label next to the string (default true!)
hbs.registerHelper('mlString', function(str: unknown, addLanguageSpan: boolean | HelperOptions, options?: HelperOptions) {
  // hbs passes options object in as last parameter
  if (arguments.length == 2) {
    options = addLanguageSpan as HelperOptions;
    addLanguageSpan = true;
  } else if (addLanguageSpan === undefined)
    addLanguageSpan = true;

  const context = getTemplateContext(options as HelperOptions);
  const mlRv = resolveMultilingual(context.locale, str);

  if (mlRv === undefined || mlRv.str === undefined || mlRv.str === '')
    return undefined;

  // Note that we don't show the label if we can't identify the language ('und')
  if (!addLanguageSpan || mlRv.lang === context.locale || mlRv.lang == 'und')
    return mlRv.str;
  else {
    const resolvedLanguage = mlRv.lang as LocaleCodeWithUndetermined;
    const translationLocale = (context.locale ?? 'en') as LocaleCodeWithUndetermined;
    const languageName = languages.getCompositeName(resolvedLanguage, translationLocale);
    return `${mlRv.str} <span class="language-identifier" title="${languageName}">` +
      `<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>${mlRv.lang}</span>`;
  }
});

hbs.registerHelper('round', (num, dec) => +num.toFixed(dec));

hbs.registerHelper('ifCond', function(v1, operator, v2, options: HelperOptions) {
  switch (operator) {
    case '==':
      return v1 == v2 ? options.fn(this) : options.inverse(this);
    case '===':
      return v1 === v2 ? options.fn(this) : options.inverse(this);
    case '<':
      return v1 < v2 ? options.fn(this) : options.inverse(this);
    case '<=':
      return v1 <= v2 ? options.fn(this) : options.inverse(this);
    case '>':
      return v1 > v2 ? options.fn(this) : options.inverse(this);
    case '>=':
      return v1 >= v2 ? options.fn(this) : options.inverse(this);
    case '&&':
      return v1 && v2 ? options.fn(this) : options.inverse(this);
    case '||':
      return v1 || v2 ? options.fn(this) : options.inverse(this);
    default:
      return options.inverse(this);
  }
});

hbs.registerHelper('renderFilePreview', function(file: { mimeType: string; name: string }, restricted: boolean) {
  const path = restricted ? 'restricted/' : '';
  const wrap = str => `<div class="file-preview">${str}</div>`;
  if (/^image\//.test(file.mimeType))
    return wrap(`<img src="/static/uploads/${path}${file.name}">`);
  else if (/^video\//.test(file.mimeType))
    return wrap(`<video src="/static/uploads/${path}${file.name}" controls>`);
  else if (/^audio\//.test(file.mimeType))
    return wrap(`<audio src="/static/uploads/${path}${file.name}" controls>`);
  else
    return '';
});

hbs.registerHelper('licenseLabel', licenseLabel);

hbs.registerHelper('licenseLink', licenseLink);

hbs.registerHelper('fileCredit', function(file: { license?: string; creator?: unknown; uploader?: { urlName?: string; displayName?: string } }, options: HelperOptions) {
  const context = getTemplateContext(options);
  const label = licenseLabel(file.license, options);
  const link = licenseLink(file.license, label);

  if (!file.creator && !file.uploader)
    return i18n.__({
      phrase: 'rights in caption, own work',
      locale: context.locale
    }, link);
  else
    return i18n.__({
        phrase: 'rights in caption, someone else\'s work',
        locale: context.locale
      },
      file.creator ?
      resolveMultilingual(context.locale, file.creator).str :
      userLink(file.uploader),
      link);
});

hbs.registerHelper('linkify', str => linkifyHTML(str, { 
  defaultProtocol: 'https',
  target: {
    url: '_blank'
    // email links won't get target="_blank"
  }
}));

function userLink(user?: { urlName?: string; displayName?: string } | null) {
  return user ? `<a href="/user/${user.urlName ?? ''}">${user.displayName ?? ''}</a>` : '';
}

function licenseLabel(license: string | undefined, options: HelperOptions) {
  const context = getTemplateContext(options);
  const key = license === 'fair-use' ? 'fair use short' : `${license} short`;
  return i18n.__({ phrase: key, locale: context.locale });
}

function licenseLink(license: string | undefined, licenseLabel: string) {
  const url = getLicenseURL(license);
  return url ? `<a href="${url}">${licenseLabel}</a>` : licenseLabel;
}
