// External dependencies

import escapeHTML from 'escape-html';
import type { HelperOptions } from 'handlebars';
import hbs from 'hbs';
import i18n from 'i18n';
import linkifyHTML from 'linkify-html';
import stripTags from 'striptags';
import adapters from '../adapters/adapters.ts';
// Internal dependencies
import mlString, { type MultilingualString } from '../dal/lib/ml-string.ts';
import type { LocaleCodeWithUndetermined } from '../locales/languages.ts';
import languages from '../locales/languages.ts';
import type { ThingInstance } from '../models/manifests/thing.ts';
import thingModelHandle from '../models/thing.ts';
import { autolink } from '../routes/helpers/formatters.ts';
import type { TemplateContext } from '../types/http/locals.ts';
import { formatLongDate, formatShortDate } from './date.ts';
import debug from './debug.ts';
import getLicenseURL from './get-license-url.ts';
import urlUtils from './url-utils.ts';

/**
 * Extract the template context that Handlebars tucks away inside helper options.
 * Falls back to an empty object so helpers can safely destructure optional values.
 */
const getTemplateContext = (options: HelperOptions): TemplateContext =>
  (options?.data?.root ?? {}) as TemplateContext;

/**
 * Resolve any supported mlString structure into the most appropriate translation
 * for the current locale. Used by mlSafeText and mlHTML helpers.
 */
const resolveMultilingual = (locale: string, value: unknown) =>
  mlString.resolve(locale, value as MultilingualString | null | undefined);

/**
 * Determine whether we should append a language identifier badge.
 * We only show the badge when one was requested, the language differs
 * from the current locale, and the translation is not "und".
 */
const shouldAddLanguageIdentifier = (
  addLanguageSpan: boolean,
  resolvedLanguage: string | undefined,
  locale: string | undefined
) =>
  Boolean(resolvedLanguage) &&
  addLanguageSpan &&
  resolvedLanguage !== locale &&
  resolvedLanguage !== 'und';

/**
 * Render the standard language badge markup so every helper stays consistent.
 * The badge includes an accessible tooltip with the localized language name.
 */
const renderLanguageIdentifier = (resolvedLanguage: string, locale: string | undefined) => {
  const resolvedLocale = resolvedLanguage as LocaleCodeWithUndetermined;
  const translationLocale = (locale ?? 'en') as LocaleCodeWithUndetermined;
  const languageName = languages.getCompositeName(resolvedLocale, translationLocale);
  return (
    `<span class="language-identifier" title="${languageName}">` +
    `<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>${resolvedLanguage}</span>`
  );
};

/**
 * Resolve a thing's display label in the current locale, with safe fallbacks.
 *
 * @param thing
 *  Thing object or plain data used by the template
 * @param locale
 *  Active locale for rendering
 * @returns Localized label, prettified URL, or an empty string
 */
function getThingLabel(thing: ThingInstance | null | undefined, locale: string): string {
  if (!thing) {
    return '';
  }

  const modelGetLabel = thingModelHandle?.getLabel;

  if (typeof modelGetLabel === 'function') {
    try {
      const label = modelGetLabel.call(thingModelHandle, thing as ThingInstance, locale);
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
hbs.registerHelper('times', function (this: unknown, n: number, block: HelperOptions) {
  let data: Record<string, unknown> = {};
  let rv = '';

  if (block.data) data = hbs.handlebars.createFrame(block.data);

  for (let i = 1; i <= n; i++) {
    data.zeroIndex = i - 1;
    data.first = i == 1;
    data.last = i == n;
    rv += (block.fn?.(i, { data }) ?? '').trim();
  }
  return rv;
});

hbs.registerHelper('escapeHTML', function (this: unknown, block: HelperOptions) {
  return escapeHTML((block.fn?.(this) ?? '').toString());
});

hbs.registerHelper('link', (url: string, title: string, singleQuotes?: boolean) => {
  const q = singleQuotes ? "'" : '"';
  return `<a href=${q}${url}${q}>${title}</a>`;
});

// Strips HTML and shortens to specified length
hbs.registerHelper('summarize', (html: unknown, length: number) => {
  const stripped = stripTags(`${html ?? ''}`);
  let shortened = stripped.substr(0, length);
  if (stripped.length > length) shortened += '...';
  return shortened;
});

hbs.registerHelper('userLink', userLink);

hbs.registerHelper('prettify', (url?: string | null) => {
  if (url) return urlUtils.prettify(url);
  else return '';
});

hbs.registerHelper('shortDate', (date: Date | string | number) => formatShortDate(date));

hbs.registerHelper('longDate', (date: Date | string | number) => formatLongDate(date));

// Sources are external sites we interface with; if they're known sources,
// they have a message key of this standard format.
hbs.registerHelper('getSourceMsgKey', sourceID => `${sourceID} source label`);

// Licensing notices for sources follow a similar pattern
hbs.registerHelper('getSourceLicensingKey', sourceID => `${sourceID} license`);

// Tags are used to classify sources into domains like "Databases"; these, too,
// have message keys.
hbs.registerHelper('getTagMsgKey', sourceID => `${sourceID} tag label`);

hbs.registerHelper('getSourceURL', sourceID => adapters.getSourceURL(sourceID));

hbs.registerHelper('__', (...args: unknown[]) => {
  const options = args.pop() as HelperOptions;

  // Convert SafeString objects to plain strings for i18n substitution
  const unwrappedArgs = args.map(arg => {
    if (arg && typeof arg === 'object' && 'string' in arg) {
      return String(arg);
    }
    return arg;
  });

  return Reflect.apply(i18n.__, getTemplateContext(options), unwrappedArgs);
});

hbs.registerHelper('__n', (...args: unknown[]) => {
  const options = args.pop() as HelperOptions;

  // Convert SafeString objects to plain strings for i18n substitution
  const unwrappedArgs = args.map(arg => {
    if (arg && typeof arg === 'object' && 'string' in arg) {
      return String(arg);
    }
    return arg;
  });

  return Reflect.apply(i18n.__n, getTemplateContext(options), unwrappedArgs);
});

// Get the language code that will result from resolving a string to the
// current request language (may be a fallback if no translation available).
hbs.registerHelper('getLang', (str: unknown, options: HelperOptions) => {
  const context = getTemplateContext(options);
  const mlRv = resolveMultilingual(context.locale, str);
  return mlRv ? mlRv.lang : undefined;
});

hbs.registerHelper(
  'getThingLabel',
  (thing: ThingInstance | null | undefined, options: HelperOptions) => {
    const context = getTemplateContext(options);
    return getThingLabel(thing, context.locale);
  }
);

// Just a simple %1, %2 substitution function for various purposes
hbs.registerHelper('substitute', (...args) => {
  let i = 1,
    string = args.shift();
  // Note: .replace() coerces SafeString to string via toString()

  while (args.length) {
    let sub = args.shift();
    string = string.replace(`%${i}`, sub);
    i++;
  }
  return string;
});

hbs.registerHelper(
  'getThingLink',
  (thing: ThingInstance | null | undefined, options: HelperOptions) => {
    if (!thing) {
      return '';
    }
    const context = getTemplateContext(options);
    const label = getThingLabel(thing, context.locale);
    return `<a href="/${thing.urlID ?? ''}">${label || ''}</a>`;
  }
);

// Filenames cannot contain HTML metacharacters, so URL encoding is sufficient here
hbs.registerHelper(
  'getFileLink',
  filename => `<a href="/static/uploads/${encodeURIComponent(filename)}">${filename}</a>`
);

hbs.registerHelper('getLanguageName', (lang: string, options: HelperOptions) => {
  const context = getTemplateContext(options);
  const targetLanguage = lang as LocaleCodeWithUndetermined;
  const translationLocale = (context.locale ?? 'en') as LocaleCodeWithUndetermined;
  return languages.getTranslatedName(targetLanguage, translationLocale);
});

hbs.registerHelper('isoDate', (date: { toISOString?: () => string } | null | undefined) =>
  date && typeof date.toISOString === 'function' ? date.toISOString() : undefined
);

/**
 * Render HTML-safe multilingual text content.
 *
 * Use for text fields (labels, titles, names, descriptions) that store HTML-safe
 * text format: entities escaped (`My &amp; Co`), tags rejected. This helper
 * renders the content as-is without additional escaping since it's already safe.
 *
 * Storage format: Text is entity-escaped at write time by form handlers/adapters
 * Browser automatically decodes entities when rendering: `&amp;` displays as `&`
 *
 * Usage:
 *   {{mlSafeText review.title}}          - With language indicator if needed
 *   {{mlSafeText review.title false}}    - Without language indicator
 *
 * For plain text output (emails, etc.): Use decodeHTML() on the field first
 * For HTML output: Use as-is (this helper)
 */
hbs.registerHelper(
  'mlSafeText',
  (...raw: [unknown, HelperOptions] | [unknown, boolean, HelperOptions]) => {
    const [str, addLanguageSpan, options] =
      raw.length === 2 ? [raw[0], true, raw[1]] : [raw[0], raw[1] as boolean, raw[2]];

    const context = getTemplateContext(options);
    const mlRv = resolveMultilingual(context.locale, str);

    if (mlRv === undefined || mlRv.str === undefined || mlRv.str === '') return undefined;

    // No escaping - data is already entity-escaped at write time by form handlers/adapters
    if (!shouldAddLanguageIdentifier(addLanguageSpan, mlRv.lang, context.locale)) {
      return new hbs.handlebars.SafeString(mlRv.str);
    }

    return new hbs.handlebars.SafeString(
      `${mlRv.str}${renderLanguageIdentifier(mlRv.lang ?? 'und', context.locale)}`
    );
  }
);

/**
 * Render multilingual HTML content.
 *
 * Use for HTML fields that contain rendered markup (typically cached markdown output).
 * These fields store actual HTML tags and should be rendered without escaping.
 *
 * Storage format: Contains HTML markup like `<p>My &amp; Co</p>`
 * Unlike mlText, this is NOT entity-escaped plain text - it's actual HTML.
 *
 * Usage:
 *   {{{mlHTML review.html}}}         - Rendered review content
 *   {{{mlHTML team.description.html}}} - Rendered description
 *
 * Security: Content must be sanitized before storage (e.g., from trusted markdown renderer)
 * Type safety: Schema validation ensures HTML fields are only used with mlHTML helper
 */
hbs.registerHelper(
  'mlHTML',
  (...raw: [unknown, HelperOptions] | [unknown, boolean, HelperOptions]) => {
    const [str, addLanguageSpan, options] =
      raw.length === 2 ? [raw[0], false, raw[1]] : [raw[0], raw[1] as boolean, raw[2]];

    const context = getTemplateContext(options);
    const mlRv = resolveMultilingual(context.locale, str);

    if (mlRv === undefined || mlRv.str === undefined || mlRv.str === '') return undefined;

    if (!shouldAddLanguageIdentifier(addLanguageSpan, mlRv.lang, context.locale)) {
      return new hbs.handlebars.SafeString(mlRv.str);
    }

    return new hbs.handlebars.SafeString(
      `${mlRv.str}${renderLanguageIdentifier(mlRv.lang ?? 'und', context.locale)}`
    );
  }
);

// Resolve a multilingual string to the current request language.
//
// addLanguageSpan -- Do we want a little label next to the string (default true!)
// 2 args:  [str, options]
// 3 args:  [str, addLanguageSpan, options]
hbs.registerHelper(
  'mlString',
  (...raw: [unknown, HelperOptions] | [unknown, boolean, HelperOptions]) => {
    const [str, addLanguageSpan, options] =
      raw.length === 2 ? [raw[0], true, raw[1]] : [raw[0], raw[1] as boolean, raw[2]];

    const context = getTemplateContext(options);
    const mlRv = resolveMultilingual(context.locale, str);

    if (mlRv === undefined || mlRv.str === undefined || mlRv.str === '') return undefined;

    // Note that we don't show the label if we can't identify the language ('und')
    if (!addLanguageSpan || mlRv.lang === context.locale || mlRv.lang == 'und') return mlRv.str;
    else {
      const resolvedLanguage = mlRv.lang as LocaleCodeWithUndetermined;
      const translationLocale = (context.locale ?? 'en') as LocaleCodeWithUndetermined;
      const languageName = languages.getCompositeName(resolvedLanguage, translationLocale);
      return (
        `${mlRv.str} <span class="language-identifier" title="${languageName}">` +
        `<span class="fa fa-fw fa-globe language-identifier-icon">&nbsp;</span>${mlRv.lang}</span>`
      );
    }
  }
);

hbs.registerHelper('round', (num, dec) => +num.toFixed(dec));

hbs.registerHelper('ifCond', function (v1, operator, v2, options: HelperOptions) {
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

hbs.registerHelper(
  'renderFilePreview',
  (file: { mimeType: string; name: string }, restricted: boolean) => {
    const path = restricted ? 'restricted/' : '';
    const wrap = str => `<div class="file-preview">${str}</div>`;
    if (/^image\//.test(file.mimeType))
      return wrap(`<img src="/static/uploads/${path}${file.name}">`);
    else if (/^video\//.test(file.mimeType))
      return wrap(`<video src="/static/uploads/${path}${file.name}" controls>`);
    else if (/^audio\//.test(file.mimeType))
      return wrap(`<audio src="/static/uploads/${path}${file.name}" controls>`);
    else return '';
  }
);

hbs.registerHelper('licenseLabel', licenseLabel);

hbs.registerHelper('licenseLink', licenseLink);

hbs.registerHelper(
  'fileCredit',
  (
    file: {
      license?: string;
      creator?: unknown;
      uploader?: { urlName?: string; displayName?: string };
    },
    options: HelperOptions
  ) => {
    const context = getTemplateContext(options);
    const label = licenseLabel(file.license, options);
    const link = licenseLink(file.license, label);

    if (!file.creator && !file.uploader)
      return i18n.__(
        {
          phrase: 'rights in caption, own work',
          locale: context.locale,
        },
        link
      );
    else
      return i18n.__(
        {
          phrase: "rights in caption, someone else's work",
          locale: context.locale,
        },
        file.creator
          ? resolveMultilingual(context.locale, file.creator).str
          : userLink(file.uploader),
        link
      );
  }
);

hbs.registerHelper('linkify', str => {
  // Convert to string (handles SafeString objects via toString())
  const plainStr = String(str ?? '');

  return linkifyHTML(plainStr, {
    defaultProtocol: 'https',
    target: {
      url: '_blank',
      // email links won't get target="_blank"
    },
  });
});

hbs.registerHelper('autolink', (text: unknown) => {
  return new hbs.handlebars.SafeString(autolink(String(text ?? '')));
});

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
