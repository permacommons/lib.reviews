'use strict';
// External deps
const decodeHTML = require('entities').decodeHTML;
const stripTags = require('striptags');

// Internal deps
const languages = require('../../locales/languages');
const langKeys = languages.getValidLanguagesAndUndetermined();
const thinky = require('../../db');
const type = thinky.type;

/**
 * Helper methods for handling multilingual strings.
 *
 * @namespace MlString
 */
const mlString = {

  /**
   * Obtain a Thinky type definition for a multilingual string object which
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
   * @returns {TypeObject}
   *  type definition
   * @memberof MlString
   */
  getSchema({
      maxLength = undefined,
      array = false
    } = {}) {

    let schema = {};
    for (let key of langKeys) {
      let typeDef = type.string();
      if (maxLength)
        typeDef.max(maxLength);

      if (array)
        typeDef = type.array(typeDef);

      schema[key] = typeDef;

    }

    return type
      .object()
      .schema(schema)
      .allowExtra(false);

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
    if (strObj === undefined)
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
    if (typeof strObj !== 'object')
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
  }

};

module.exports = mlString;
