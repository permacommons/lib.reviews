// External deps
import entities from 'entities';
import stripTags from 'striptags';

// Internal deps
import languages from '../../locales/languages.js';
import type from './type.mjs';
import { ValidationError } from './errors.mjs';

const { decodeHTML } = entities;
const langKeys = languages.getValidLanguagesAndUndetermined();

/**
 * Helper methods for handling multilingual strings in PostgreSQL JSONB columns.
 * This is the PostgreSQL DAL version of the original ml-string helper.
 *
 * @namespace MlString
 */
const mlString = {

  /**
   * Obtain a type definition for a multilingual string object which
   * permits only strings in the supported languages defined in `locales/`.
   * Language keys like 'en' are used as object keys, so you can use syntax like
   * `label.en`, or `aliases.fr[0]` for arrays.
   *
   * @param {Object} [options]
   *  settings for this type definition
   * @param {Number} options.maxLength
   *  maximum length for any individual string. If not set, no maximum is
   *  enforced.
   * @param {Boolean} options.array=false
   *  Set this to true for strings of the form
   *
   *  ````
   *  {
   *    en: ['something', 'other'],
   *    de: ['something']
   *  }
   *  ````
   *
   *  For arrays of multilingual strings, instead encapsulate getSchema in an
   *  array in the schema definition.
   * @returns {ObjectType}
   *  type definition for JSONB column
   * @memberof MlString
   */
  getSchema({
      maxLength = undefined,
      array = false
    } = {}) {

    const objectType = type.object();
    
    // Add custom validator for multilingual string structure
    objectType.validator((value) => {
      if (value === null || value === undefined) {
        return true;
      }

      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationError('Multilingual string must be an object');
      }

      // Validate each language key and value
      for (const [langKey, langValue] of Object.entries(value)) {
        // Validate language key
        if (!langKeys.includes(langKey)) {
          throw new ValidationError(`Invalid language code: ${langKey}. Valid codes are: ${langKeys.join(', ')}`);
        }

        // Validate language value
        if (array) {
          if (!Array.isArray(langValue)) {
            throw new ValidationError(`Value for language '${langKey}' must be an array when array=true`);
          }
          
          for (const [index, item] of langValue.entries()) {
            if (typeof item !== 'string') {
              throw new ValidationError(`Array item at index ${index} for language '${langKey}' must be a string`);
            }
            
            if (maxLength && item.length > maxLength) {
              throw new ValidationError(`Array item at index ${index} for language '${langKey}' exceeds maximum length of ${maxLength} characters`);
            }
          }
        } else {
          if (typeof langValue !== 'string') {
            throw new ValidationError(`Value for language '${langKey}' must be a string`);
          }
          
          if (maxLength && langValue.length > maxLength) {
            throw new ValidationError(`Value for language '${langKey}' exceeds maximum length of ${maxLength} characters`);
          }
        }
      }

      return true;
    });

    return objectType;
  },

  /**
   * The result of resolving a multilingual string to a given language.
   *
   * @typedef {Object} ResolveResult
   * @property {Object} result
   * @property {String} result.str
   *  string in the best available language for the original lookup
   * @property {String} result.lang
   *  the language code identifying that language
   */

  /**
   * Find the best fit for a given language from a multilingual string object,
   * taking into account fallbacks.
   *
   * @param {String} lang
   *  the preferred language code of the target string
   * @param {Object} strObj
   *  a multilingual string object
   * @returns {ResolveResult}
   *  or undefined if we can't find any suitable string
   * @memberof MlString
   */
  resolve(lang, strObj) {
    if (strObj === undefined || strObj === null)
      return undefined;

    // We have a string in the specified language
    // Note that emptying a string reverts back to other available languages
    if (strObj[lang] !== undefined && strObj[lang] !== '')
      return {
        str: strObj[lang],
        lang
      };

    // Try specific fallbacks for this language first, e.g. European Portuguese
    // for Brazilian Portuguese. English is a declared fallback for all languages.
    let fallbackLanguages = languages.getFallbacks(lang);
    for (let fallbackLanguage of fallbackLanguages) {
      if (strObj[fallbackLanguage] !== undefined && strObj[fallbackLanguage] !== '')
        return {
          str: strObj[fallbackLanguage],
          lang: fallbackLanguage
        };
    }

    // Pick first available language
    let availableLanguages = Object.keys(strObj);
    for (let availableLanguage of availableLanguages) {
      if (languages.isValid(availableLanguage) &&
        strObj[availableLanguage] !== undefined &&
        strObj[availableLanguage] !== '')
        return {
          str: strObj[availableLanguage],
          lang: availableLanguage
        };
    }

    // This may not be a valid multilingual string object at all, or all strings
    // are empty.
    return undefined;
  },

  /**
   * @param {Object} strObj
   *  a multilingual string object
   * @returns {Object}
   *  string object with HTML entities decoded and HTML elements stripped
   * @memberof MlString
   */
  stripHTML(strObj) {
    if (typeof strObj !== 'object' || strObj === null)
      return strObj;

    let rv = {};
    for (let lang in strObj) {
      if (typeof strObj[lang] == 'string')
        rv[lang] = stripTags(decodeHTML(strObj[lang]));
      else
        rv[lang] = strObj[lang];
    }
    return rv;
  },

  /**
   * @param {Object[]} strObjArr
   *  an array of multilingual string objects
   * @returns {Object[]}
   *  string object array with HTML entities decoded and HTML elements stripped
   * @memberof MlString
   */
  stripHTMLFromArray(strObjArr) {
    if (!Array.isArray(strObjArr))
      return strObjArr;
    else
      return strObjArr.map(mlString.stripHTML);
  },

  /**
   * Generate PostgreSQL JSONB query conditions for multilingual string fields.
   * This helps with querying JSONB columns containing multilingual strings.
   *
   * @param {String} fieldName - The JSONB column name
   * @param {String} lang - Language code to query
   * @param {String} value - Value to search for
   * @param {String} [operator='='] - SQL operator ('=', 'ILIKE', etc.)
   * @returns {String} PostgreSQL query condition
   * @memberof MlString
   */
  buildQuery(fieldName, lang, value, operator = '=') {
    // Validate language
    if (!langKeys.includes(lang)) {
      throw new ValidationError(`Invalid language code: ${lang}`);
    }

    // Build JSONB query
    if (operator.toUpperCase() === 'ILIKE') {
      return `${fieldName}->>'${lang}' ILIKE $1`;
    } else {
      return `${fieldName}->>'${lang}' ${operator} $1`;
    }
  },

  /**
   * Generate PostgreSQL JSONB query for searching across all languages in a multilingual field.
   *
   * @param {String} fieldName - The JSONB column name
   * @param {String} searchTerm - Term to search for
   * @param {String} [operator='ILIKE'] - SQL operator
   * @returns {String} PostgreSQL query condition
   * @memberof MlString
   */
  buildMultiLanguageQuery(fieldName, searchTerm, operator = 'ILIKE') {
    const conditions = langKeys.map(lang => 
      `${fieldName}->>'${lang}' ${operator} $1`
    );
    return `(${conditions.join(' OR ')})`;
  },

  /**
   * Validate that a value is a properly structured multilingual string object.
   *
   * @param {*} value - Value to validate
   * @param {Object} [options] - Validation options
   * @param {Number} [options.maxLength] - Maximum length for individual strings
   * @param {Boolean} [options.array=false] - Whether values should be arrays
   * @returns {Boolean} True if valid
   * @throws {ValidationError} If validation fails
   * @memberof MlString
   */
  validate(value, options = {}) {
    const schema = mlString.getSchema(options);
    try {
      schema.validate(value, 'multilingual string');
      return true;
    } catch (error) {
      throw error;
    }
  },

  /**
   * Get all valid language keys including 'und' (undetermined).
   *
   * @returns {String[]} Array of valid language codes
   * @memberof MlString
   */
  getValidLanguageKeys() {
    return langKeys.slice(); // Return a copy
  },

  /**
   * Check if a language key is valid.
   *
   * @param {String} langKey - Language code to check
   * @returns {Boolean} True if valid
   * @memberof MlString
   */
  isValidLanguageKey(langKey) {
    return langKeys.includes(langKey);
  }

};

export { mlString };
export default mlString;