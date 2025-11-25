import { decodeHTML } from 'entities';
import stripTags from 'striptags';

import languages from '../../locales/languages.ts';
import { ValidationError } from './errors.ts';
import types, { ObjectType } from './type.ts';

const langKeys = languages.getValidLanguagesAndUndetermined() as string[];

type MultilingualValue = Record<string, string | string[]>;

export type MultilingualString = Record<string, string>;

type MultilingualStringArray = Record<string, string[]>;

export interface ResolveResult {
  str: string;
  lang: string;
}

export interface MlStringSchemaOptions {
  maxLength?: number;
  array?: boolean;
  allowHTML?: boolean;
}

export interface MlStringPlainTextSchemaOptions extends Omit<MlStringSchemaOptions, 'allowHTML'> {}

export interface MlStringHTMLSchemaOptions {
  maxLength?: number;
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

/**
 * Interface providing overloaded signatures for mlString schema methods.
 * Enables proper type inference based on the `array` option.
 */
interface MlStringVariants {
  getSchema(options: MlStringSchemaOptions & { array: true }): ObjectType<string[]>;
  getSchema(options?: MlStringSchemaOptions & { array?: false }): ObjectType<string>;
  getSchema(options?: MlStringSchemaOptions): ObjectType<string>;

  getSafeTextSchema(
    options: MlStringPlainTextSchemaOptions & { array: true }
  ): ObjectType<string[]>;
  getSafeTextSchema(options?: MlStringPlainTextSchemaOptions): ObjectType<string>;

  getHTMLSchema(options?: MlStringHTMLSchemaOptions): ObjectType<string>;
  getRichTextSchema(): ObjectType<MultilingualRichText>;

  resolve(
    lang: string,
    strObj: Record<string, string> | null | undefined
  ): ResolveResult | undefined;

  stripHTML<T extends MultilingualInput>(strObj: T): T;
  stripHTMLFromArray<T extends MultilingualInput>(strObjArr: T[]): T[];
  stripHTMLFromArrayValues(strObj: MultilingualStringArray): MultilingualStringArray;
  buildQuery(fieldName: string, lang: string, value: string, operator?: string): string;
  buildMultiLanguageQuery(fieldName: string, searchTerm: string, operator?: string): string;
  validate(value: unknown, options?: MlStringSchemaOptions): boolean;
  getValidLanguageKeys(): string[];
  isValidLanguageKey(langKey: string): boolean;
}

const mlString = {
  /**
   * Obtain a type definition for a multilingual string object which
   * permits only strings in the supported languages defined in `locales/`.
   *
   * Storage format: Text fields store "HTML-safe text" with entities escaped
   * (e.g., `My &amp; Co`) but HTML tags removed/rejected. This allows safe
   * rendering in HTML templates while preserving user's literal text input.
   *
   * Options:
   * - `maxLength`: maximum length enforced for each value
   * - `array`: when true, validates string arrays per language (returns ObjectType<string[]>)
   * - `allowHTML`: when true, allows HTML tags (default: false for security)
   *
   * Note: HTML entities like `&amp;` are allowed regardless of `allowHTML` setting.
   * Only actual HTML tags like `<script>` are validated.
   */
  getSchema({
    maxLength,
    array = false,
    allowHTML = false,
  }: MlStringSchemaOptions = {}): ObjectType<string> | ObjectType<string[]> {
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

            if (!allowHTML) {
              const stripped = stripTags(item);
              if (stripped !== item) {
                throw new ValidationError(
                  `Plain text field for language '${langKey}' contains HTML tags`
                );
              }
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

          if (!allowHTML) {
            const stripped = stripTags(langValue);
            if (stripped !== langValue) {
              throw new ValidationError(
                `Plain text field for language '${langKey}' contains HTML tags`
              );
            }
          }
        }
      }

      return true;
    });

    return objectType as ObjectType<string> | ObjectType<string[]>;
  },

  /**
   * Obtain a schema that enforces HTML-safe text multilingual strings.
   *
   * HTML-safe text format:
   * - HTML entities are escaped (e.g., `&` → `&amp;`, `<` → `&lt;`)
   * - HTML tags are rejected
   * - User input like "I like <b>" is preserved as "I like &lt;b&gt;"
   * - Safe to render directly in HTML templates without additional escaping
   *
   * Use for: labels, titles, names, descriptions (non-HTML fields)
   * Array validation may be enabled for multiple values per language.
   */
  getSafeTextSchema(
    options: MlStringPlainTextSchemaOptions = {}
  ): ObjectType<string> | ObjectType<string[]> {
    return mlString.getSchema({ ...options, allowHTML: false });
  },

  /**
   * Obtain a schema for multilingual HTML strings.
   *
   * HTML strings contain actual HTML markup (tags and entities) that should be
   * rendered without escaping. Typically used for cached markdown output where
   * the markdown has been converted to safe HTML.
   *
   * Use for: review.html, blogPost.html, etc. (rendered content fields)
   *
   * Security: Content should be sanitized before storage to prevent XSS.
   */
  getHTMLSchema(options: MlStringHTMLSchemaOptions = {}) {
    return mlString.getSchema({ ...options, allowHTML: true });
  },

  /**
   * Obtain a schema for rich text objects containing both source and rendered content.
   *
   * Rich text format: { text: MlString, html: MlString }
   * - `text`: HTML-safe markdown source (entities escaped, tags rejected)
   * - `html`: Rendered HTML from markdown (contains actual HTML markup)
   *
   * Use for: team.description, team.rules, userMeta.bio
   * (fields that store both markdown source and cached HTML output)
   */
  getRichTextSchema() {
    const objectType = types.object();

    objectType.validator(value => {
      if (value === null || value === undefined) {
        return true;
      }

      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('Multilingual rich text must be an object');
      }

      const { text, html, ...rest } = value as MultilingualRichText & Record<string, unknown>;

      const extraKeys = Object.keys(rest);
      if (extraKeys.length > 0) {
        throw new ValidationError(
          `Rich text object contains unsupported keys: ${extraKeys.join(', ')}`
        );
      }

      if (text !== undefined) {
        mlString.getSchema({ allowHTML: false }).validate(text, 'rich text.text');
      }

      if (html !== undefined) {
        mlString.getSchema({ allowHTML: true }).validate(html, 'rich text.html');
      }

      return true;
    });

    return objectType as ObjectType<MultilingualRichText>;
  },

  /**
   * Find the best fit for a given language from a multilingual string object,
   * taking into account fallbacks.
   */
  resolve(lang: string, strObj: MultilingualString | null | undefined): ResolveResult | undefined {
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
   * Strip HTML tags and decode entities from multilingual string.
   *
   * Use for external/adapter data that may contain unwanted HTML formatting.
   * After stripping, the result should be entity-escaped again before storage
   * to maintain the "HTML-safe text" format.
   *
   * Example: `<b>Label</b> &amp; Co` → `Label & Co`
   * Then escape for storage: `Label & Co` → `Label &amp; Co`
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
   * Multilingual object with array values - strips HTML from each string in each array.
   * Used for fields like aliases where structure is { en: ["str1", "str2"], de: [...] }
   */
  stripHTMLFromArrayValues(strObj: MultilingualStringArray): MultilingualStringArray {
    if (typeof strObj !== 'object' || strObj === null) {
      return strObj;
    }

    const result: Record<string, string[]> = {};
    for (const [lang, values] of Object.entries(strObj)) {
      if (Array.isArray(values)) {
        result[lang] = values.map(v => (typeof v === 'string' ? stripTags(decodeHTML(v)) : v));
      } else {
        result[lang] = values;
      }
    }

    return result;
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

// Export with overloaded type for proper inference at call sites
const typedMlString: MlStringVariants = mlString as MlStringVariants;

export type { MlStringVariants };
export { typedMlString as mlString };
export default typedMlString;
