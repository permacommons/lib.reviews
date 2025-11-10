declare global {
  namespace LibReviews {
    /**
     * Locale identifiers supported by the translation system. They map
     * directly to the language files and validation helpers in `locales/languages.ts`.
     */
    type LocaleCode =
      | 'en'
      | 'ar'
      | 'bn'
      | 'de'
      | 'eo'
      | 'es'
      | 'fi'
      | 'fr'
      | 'hi'
      | 'hu'
      | 'it'
      | 'ja'
      | 'lt'
      | 'mk'
      | 'nl'
      | 'pt'
      | 'pt-PT'
      | 'sk'
      | 'sl'
      | 'sv'
      | 'tr'
      | 'uk'
      | 'zh'
      | 'zh-Hant';

    type LocaleCodeWithUndetermined = LocaleCode | 'und';
  }
}

export type LocaleCode = LibReviews.LocaleCode;
export type LocaleCodeWithUndetermined = LibReviews.LocaleCodeWithUndetermined;

/**
 * Canonical list of locale codes used by the language helper when rendering
 * dropdowns and validating user preferences.
 */
export declare const SUPPORTED_LOCALES: readonly LocaleCode[];
