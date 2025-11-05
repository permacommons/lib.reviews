// NOTE: This module loads language metadata into memory synchronously and
// should be imported on startup.

import { createRequire } from 'node:module';
import path from 'node:path';
// External dependencies
import jsonfile from 'jsonfile';

// Internal dependencies
import ReportedError from '../util/reported-error.ts';

const require = createRequire(import.meta.url);

// To add support for a new language, first add the locale file (JSON format)
// with the translations to the locales/ directory. Then add the new language
// code to this array. Language names will be automatically imported from CLDR
// on the next restart.
const VALID_LANGUAGES = [
  'en',
  'ar',
  'bn',
  'de',
  'eo',
  'es',
  'fi',
  'fr',
  'hi',
  'hu',
  'it',
  'ja',
  'lt',
  'mk',
  'nl',
  'pt',
  'pt-PT',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'zh',
  'zh-Hant',
] as const satisfies ReadonlyArray<LibReviews.LocaleCode>;

type LocaleCode = LibReviews.LocaleCode;
type LocaleCodeWithUndetermined = LibReviews.LocaleCodeWithUndetermined;
type LanguageKey = (typeof VALID_LANGUAGES)[number];

type LanguageDisplayMap = Record<string, string>;

type LanguageNameData = Record<string, LanguageDisplayMap>;

const languageNameMap: Record<string, string> = {
  // CLDR uses the unqualified key (e.g., "pt" for Portuguese) for the version
  // used by the most speakers, and to avoid duplication, there isn't even a
  // directory for the version with the qualifier. We use the same minimal codes,
  // but the qualification matters for purposes of looking up the language names,
  // so we use this map to remember which specific locale name to look up.
  pt: 'pt-BR',
  zh: 'zh-Hans',
};

interface CldrLanguageFile {
  main: Record<
    string,
    {
      localeDisplayNames: {
        languages: LanguageDisplayMap;
      };
    }
  >;
}

const langData: LanguageNameData = Object.create(null);

// Import language names from CLDR module
const cldrPkgPath = require.resolve('cldr-localenames-full/package.json');
const cldrPath = path.join(path.dirname(cldrPkgPath), 'main');

/* eslint no-sync: "off" */
VALID_LANGUAGES.forEach(language => {
  const contents = jsonfile.readFileSync<CldrLanguageFile>(
    path.join(cldrPath, language, 'languages.json')
  );
  const localeData = contents.main[language]?.localeDisplayNames.languages;
  if (!localeData) throw new Error(`Missing language metadata for ${language}`);
  langData[language] = localeData;
});

const SUPPORTED_LOCALES = [...VALID_LANGUAGES] as const;

const languages = {
  /**
   * Returns a list of all valid language keys. We make a copy to prevent accidental manipulation.
   */
  getValidLanguages(): LocaleCode[] {
    return [...SUPPORTED_LOCALES];
  },

  /**
   * For applications where "undetermined" is a permitted value, i.e. storage.
   */
  getValidLanguagesAndUndetermined(): LocaleCodeWithUndetermined[] {
    const arr = this.getValidLanguages();
    arr.push('und');
    return arr;
  },

  /**
   * Keys sorted alphabetically.
   */
  getValidLanguagesSorted(): LocaleCode[] {
    const sorted = this.getValidLanguages();
    sorted.sort((a, b) => {
      const upperA = a.toUpperCase();
      const upperB = b.toUpperCase();
      if (upperA > upperB) return 1;
      if (upperA < upperB) return -1;
      return 0;
    });
    return sorted;
  },

  /**
   * Returns the native name of a language, e.g. "Deutsch" for German.
   */
  getNativeName(langKey: LocaleCode | LocaleCodeWithUndetermined): string {
    const lookupKey = (languageNameMap[langKey] ?? langKey) as string;
    const data = langData[langKey] ?? langData[lookupKey] ?? langData.en;
    return data?.[lookupKey] ?? lookupKey;
  },

  /**
   * Returns a translated name of a language, e.g. "German" instead of "Deutsch".
   */
  getTranslatedName(
    langKey: LocaleCode | LocaleCodeWithUndetermined,
    translationLanguage: LocaleCode | LocaleCodeWithUndetermined
  ): string {
    const lookupKey = (languageNameMap[langKey] ?? langKey) as string;
    const translationData = langData[translationLanguage] ?? langData.en;
    return translationData?.[lookupKey] ?? lookupKey;
  },

  /**
   * Returns both the native name and a translation (if appropriate).
   */
  getCompositeName(
    langKey: LocaleCode | LocaleCodeWithUndetermined,
    translationLanguage: LocaleCode | LocaleCodeWithUndetermined
  ): string {
    const nativeName = this.getNativeName(langKey);
    const translatedName = this.getTranslatedName(langKey, translationLanguage);
    if (nativeName !== translatedName) return `${translatedName} (${nativeName})`;
    return nativeName;
  },

  /**
   * Returns a message object that includes composite language names,
   * with keys in the following format: `language ${languageKey} composite name`.
   */
  getCompositeNamesAsMessageObject(langKey: LocaleCode): Record<string, string> {
    const rv: Record<string, string> = {};
    SUPPORTED_LOCALES.forEach(k => {
      rv[`language ${k} composite name`] = this.getCompositeName(k, langKey);
    });
    return rv;
  },

  /**
   * Validate whether the supplied language code is supported for interface selection.
   */
  isValid(langKey: string): langKey is LocaleCode {
    return SUPPORTED_LOCALES.includes(langKey as LocaleCode) && langKey !== 'und';
  },

  /**
   * Throws InvalidLanguageError for unsupported language codes (excluding 'und').
   */
  validate(langKey: string): void {
    if (!this.isValid(langKey) && langKey !== 'und') throw new InvalidLanguageError(langKey);
  },

  /**
   * Returns an array of fallback languages to try first when selecting
   * which language version to show.
   */
  getFallbacks(langKey: string): LocaleCodeWithUndetermined[] {
    const fallbacks: LocaleCodeWithUndetermined[] = ['en', 'und'];
    switch (langKey) {
      case 'pt':
        fallbacks.unshift('pt-PT');
        break;
      case 'pt-PT':
        fallbacks.unshift('pt');
        break;
      default:
    }
    return fallbacks;
  },
};

class InvalidLanguageError extends ReportedError {
  constructor(langCode: string) {
    super({
      userMessage: 'invalid language code',
      userMessageParams: [langCode],
    });
    this.name = 'InvalidLanguageError';
  }
}

export { InvalidLanguageError, SUPPORTED_LOCALES };
export type { LocaleCode, LocaleCodeWithUndetermined, LanguageKey };
export default languages;
