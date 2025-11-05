import { decodeHTML } from 'entities';
import stripTags from 'striptags';

import languages from '../../locales/languages.ts';
import types, { ObjectType } from './type.ts';
import { ValidationError } from './errors.ts';

const langKeys = languages.getValidLanguagesAndUndetermined() as string[];

type MultilingualValue = Record<string, string | string[]>;

type MultilingualString = Record<string, string>;

type MultilingualStringArray = Record<string, string[]>;

export interface ResolveResult {
  str: string;
  lang: string;
}

export interface MlStringSchemaOptions {
  maxLength?: number;
  array?: boolean;
}

export interface MultilingualRichText {
  text?: MultilingualString;
  html?: MultilingualString;
}

export type MultilingualInput =
  | MultilingualString
  | MultilingualStringArray
  | MultilingualRichText
  | null
  | undefined;

const mlString = {
  /**
   * Obtain a type definition for a multilingual string object which
   * permits only strings in the supported languages defined in `locales/`.
   */
  getSchema({ maxLength, array = false }: MlStringSchemaOptions = {}): ObjectType {
    const objectType = types.object();

    // Add custom validator for multilingual string structure
    objectType.validator(value => {
      if (value === null || value === undefined) {
        return true;
      }

      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('Multilingual string must be an object');
      }

      for (const [langKey, langValue] of Object.entries(value as MultilingualValue)) {
        if (!langKeys.includes(langKey)) {
          throw new ValidationError(
            `Invalid language code: ${langKey}. Valid codes are: ${langKeys.join(', ')}`
          );
        }

        if (array) {
          if (!Array.isArray(langValue)) {
            throw new ValidationError(
              `Value for language '${langKey}' must be an array when array=true`
            );
          }

          for (const [index, item] of langValue.entries()) {
            if (typeof item !== 'string') {
              throw new ValidationError(
                `Array item at index ${index} for language '${langKey}' must be a string`
              );
            }

            if (maxLength && item.length > maxLength) {
              throw new ValidationError(
                `Array item at index ${index} for language '${langKey}' exceeds maximum length of ${maxLength} characters`
              );
            }
          }
        } else {
          if (typeof langValue !== 'string') {
            throw new ValidationError(`Value for language '${langKey}' must be a string`);
          }

          if (maxLength && langValue.length > maxLength) {
            throw new ValidationError(
              `Value for language '${langKey}' exceeds maximum length of ${maxLength} characters`
            );
          }
        }
      }

      return true;
    });

    return objectType;
  },

  /**
   * Find the best fit for a given language from a multilingual string object,
   * taking into account fallbacks.
   */
  resolve(
    lang: string,
    strObj: Record<string, string> | null | undefined
  ): ResolveResult | undefined {
    if (strObj === undefined || strObj === null) {
      return undefined;
    }

    if (strObj[lang] !== undefined && strObj[lang] !== '') {
      return {
        str: strObj[lang],
        lang,
      };
    }

    const fallbackLanguages = languages.getFallbacks(lang);
    for (const fallbackLanguage of fallbackLanguages) {
      const value = strObj[fallbackLanguage];
      if (value !== undefined && value !== '') {
        return {
          str: value,
          lang: fallbackLanguage,
        };
      }
    }

    for (const [availableLanguage, value] of Object.entries(strObj)) {
      if (languages.isValid(availableLanguage) && value !== undefined && value !== '') {
        return {
          str: value,
          lang: availableLanguage,
        };
      }
    }

    return undefined;
  },

  /**
   * String object with HTML entities decoded and HTML elements stripped
   */
  stripHTML<T extends MultilingualInput>(strObj: T): T {
    if (typeof strObj !== 'object' || strObj === null) {
      return strObj;
    }

    const result: Record<string, unknown> = {};
    for (const [lang, value] of Object.entries(strObj)) {
      if (typeof value === 'string') {
        result[lang] = stripTags(decodeHTML(value));
      } else {
        result[lang] = value;
      }
    }

    return result as T;
  },

  /**
   * Array of multilingual string objects with HTML stripped
   */
  stripHTMLFromArray<T extends MultilingualInput>(strObjArr: T[]): T[] {
    if (!Array.isArray(strObjArr)) {
      return strObjArr;
    }

    return strObjArr.map(value => mlString.stripHTML(value));
  },

  /**
   * Generate PostgreSQL JSONB query conditions for multilingual string fields.
   */
  buildQuery(fieldName: string, lang: string, _value: string, operator = '='): string {
    if (!langKeys.includes(lang)) {
      throw new ValidationError(`Invalid language code: ${lang}`);
    }

    if (operator.toUpperCase() === 'ILIKE') {
      return `${fieldName}->>'${lang}' ILIKE $1`;
    }

    return `${fieldName}->>'${lang}' ${operator} $1`;
  },

  /**
   * Generate PostgreSQL JSONB query for searching across all languages in a multilingual field.
   */
  buildMultiLanguageQuery(fieldName: string, _searchTerm: string, operator = 'ILIKE'): string {
    const conditions = langKeys.map(lang => `${fieldName}->>'${lang}' ${operator} $1`);
    return `(${conditions.join(' OR ')})`;
  },

  /**
   * Validate that a value is a properly structured multilingual string object.
   */
  validate(value: unknown, options: MlStringSchemaOptions = {}): boolean {
    const schema = mlString.getSchema(options);
    schema.validate(value, 'multilingual string');
    return true;
  },

  /**
   * Get all valid language keys including 'und' (undetermined).
   */
  getValidLanguageKeys(): string[] {
    return langKeys.slice();
  },

  /**
   * Check if a language key is valid.
   */
  isValidLanguageKey(langKey: string): boolean {
    return langKeys.includes(langKey);
  },
};

export type MlStringHelpers = typeof mlString;

export { mlString };

export default mlString;
