declare global {
  namespace LibReviews {
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

export declare const SUPPORTED_LOCALES: readonly LocaleCode[];
