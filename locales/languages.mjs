// NOTE: This module loads language metadata into memory synchronously and
// should be imported on startup.

// External dependencies
import jsonfile from 'jsonfile';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Internal dependencies
import ReportedError from '../util/reported-error.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// To add support for a new language, first add the locale file (JSON format)
// with the translations to the locales/ directory. Then add the new language
// code to this array. Language names will be automatically imported from CLDR
// on the next restart.
const validLanguages = ['en', 'ar', 'bn', 'de', 'eo', 'es', 'fi', 'fr', 'hi', 'hu', 'it', 'ja', 'lt', 'mk', 'nl', 'pt', 'pt-PT',
  'sk', 'sl', 'sv', 'tr', 'uk', 'zh', 'zh-Hant'];

const languageNameMap = {
  // CLDR uses the unqualified key (e.g., "pt" for Portuguese) for the version
  // used by the most speakers, and to avoid duplication, there isn't even a
  // directory for the version with the qualifier. We use the same minimal codes,
  // but the qualification matters for purposes of looking up the language names,
  // so we use this map to remember which specific locale name to look up.
  'pt': 'pt-BR',
  'zh': 'zh-Hans'
};

const langData = {};

// Import language names from CLDR module
const cldrPath = path.join(moduleDir, '../node_modules/cldr-localenames-full/main');

/* eslint no-sync: "off" */
validLanguages.forEach(language => {
  const contents = jsonfile.readFileSync(path.join(cldrPath, language, 'languages.json'));
  langData[language] = contents.main[language].localeDisplayNames.languages;
});

const languages = {
  // Returns a list of all valid language keys. We make a copy to prevent accidental manipulation.
  getValidLanguages() {
    return validLanguages.slice();
  },

  // For applications where "undetermined" is a permitted value, i.e. storage
  getValidLanguagesAndUndetermined() {
    const arr = this.getValidLanguages();
    arr.push('und');
    return arr;
  },

  // Keys sorted alphabetically
  getValidLanguagesSorted() {
    const v = languages.getValidLanguages();
    v.sort((a, b) => {
      const upperA = a.toUpperCase();
      const upperB = b.toUpperCase();
      if (upperA > upperB)
        return 1;
      else if (upperA < upperB)
        return -1;
      return 0;
    });
    return v;
  },

  // Returns the native name of a language, e.g. "Deutsch" for German
  getNativeName(langKey) {
    const lookupKey = languageNameMap[langKey] || langKey;
    return langData[langKey][lookupKey];
  },

  // Returns a translated name of a language, e.g. "German" instead of "Deutsch"
  getTranslatedName(langKey, translationLanguage) {
    const lookupKey = languageNameMap[langKey] || langKey;
    return langData[translationLanguage][lookupKey];
  },

  // Returns both the native name and a translation (if appropriate).
  getCompositeName(langKey, translationLanguage) {
    const nativeName = languages.getNativeName(langKey);
    const translatedName = languages.getTranslatedName(langKey, translationLanguage);
    if (nativeName != translatedName)
      return `${translatedName} (${nativeName})`;
    else
      return nativeName;
  },

  // Returns a message object that includes composite language names,
  // with keys in the following format:
  // `language ${languageKey} composite name`.
  getCompositeNamesAsMessageObject(langKey) {
    const rv = {};
    validLanguages.forEach(k => {
      rv[`language ${k} composite name`] = languages.getCompositeName(k, langKey);
    });
    return rv;
  },

  // und (undtermined) is a valid language for storage, but not for interface
  // selection.
  isValid(langKey) {
    return validLanguages.indexOf(langKey) !== -1 && langKey != 'und';
  },

  // throws InvalidLanguageError
  validate(langKey) {
    if (!this.isValid(langKey) && langKey != 'und')
      throw new InvalidLanguageError(langKey);
  },

  // Returns an array of fallback languages to try first when selecting
  // which language version to show. We return English as a fallback
  // if we don't have a better answer, since it's the most widely spoken
  // secondary language. 'Undetermined'/ambiguous languages are also an
  // acceptable fallback (most commonly used for personal names).
  getFallbacks(langKey) {
    const fallbacks = ['en', 'und'];
    switch (langKey) {
      case 'pt':
        fallbacks.unshift('pt-PT');
        break;
      case 'pt-PT':
        fallbacks.unshift('pt');
        break;
      // no default
    }
    return fallbacks;
  }
};

class InvalidLanguageError extends ReportedError {
  constructor(langCode) {
    super({
      userMessage: 'invalid language code',
      userMessageParams: [langCode]
    });
    this.name = 'InvalidLanguageError';
  }
}

export { InvalidLanguageError };
export default languages;
