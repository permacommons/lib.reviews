'use strict';

/**
 * Helper/handler functions for dealing with unique "slugs", i.e. short
 * human-readable strings that are part of the URL, e.g., for review subjects
 * and teams.
 *
 * @namespace SlugName
 */

// External dependencies
const unescapeHTML = require('unescape-html');
const isUUID = require('is-uuid');

// Internal dependencies
const mlString = require('./ml-string');
const AbstractGenericError = require('../../util/abstract-generic-error');
const debug = require('../../util/debug');

const slugNameHelper = {


  /**
   * Get a handler that can be attached to a model as an instance method for
   * creating/updating human-readable string (slug) used in URL to identify
   * the document.to create/update a unique
   *
   * @param {Object} spec
   *  specification for the handler
   * @param {Model} spec.SlugModel
   *  table that holds our slugs
   * @param {String} spec.slugForeignKey
   *  key used in slug table to identify foreign document
   * @param {String} spec.slugSourceField
   *  field in document table that is used to generate slug names -- assumed
   *  to be a field containing multingual string objects
   * @memberof SlugName
   * @returns {Function}
   *  See {@link SlugName~_updateSlug}.
   */
  getUpdateSlugHandler({ SlugModel, slugForeignKey, slugSourceField }) {

    /**
     * Handler for generating a slug from a configured multilingual string
     * field, assigning it and saving it. Re-uses existing slugs that have
     * previously pointed to the same document where posisble.
     *
     * @param {String} [userID]
     *  user ID to attribute to this slug
     * @param  {String} language
     *  which language should we look up from the source field? if it is not
     *  identical to the `.originalLanguage` field for the document, we will
     *  not modify the slug.
     * @returns {model}
     *  the original document with the slug name assigned to its
     *  `.canonicalSlugName` field.
     * @memberof SlugName
     * @inner
     */
    const _updateSlug = async function(userID, language) {
      let document = this;
      let originalLanguage = document.originalLanguage || 'en';

      // No update needed if changing language other than original.
      if (language !== originalLanguage)
        return document;

      let sourceString = mlString.resolve(language, document[slugSourceField]);

      if (typeof sourceString !== 'object')
        throw new InvalidSlugStringError({
          message: 'Invalid source for slug string - must be multilingual string object.'
        });

      let slugName;

      // May throw
      slugName = slugNameHelper.generateSlugName(sourceString.str);

      // No update needed if name hasn't changed
      if (slugName === document.canonicalSlugName)
        return document;

      // For debugging
      const documentTable = document.getModel().getTableName();
      const slugTable = SlugModel.getTableName();

      if (document.id)
        debug.app(`Attempting to change slug in table "${slugTable}" for document in table "${documentTable}" with ID "${document.id}" from "${document.canonicalSlugName}" to "${slugName}".`);
      else
        debug.app(`Attemping to create slug of type ${slugTable} for new document of type ${documentTable}: "${slugName}".`);

      await document.setID();
      // Create new slug
      let slug = new SlugModel({
        name: slugName,
        [slugForeignKey]: document.id,
        createdOn: new Date(),
        createdBy: userID
      });

      try {
        // Will add qualifier to de-duplicate if supported by SlugModel
        slug = await slug.qualifiedSave();
      } catch (error) {
        // Should only be passed through if SlugModel does not support de-duplication
        if (error.name === 'DuplicatePrimaryKeyError') {
          slug = await SlugModel.get(slugName);
          if (slug[slugForeignKey] !== document.id) {
            debug.app(`Could not change slug name to "${slug.name}". Already points to a different target, and no automatic resolution was attempted.`);
            throw new DuplicateSlugNameError(slug);
          } else {
            debug.app(`Slug name "${slug.name}" is already in use as a redirect - re-assigning as canonical name.`);
          }
        } else {
          throw error; // Some other save problem we shouldn't ignore
        }
      }
      document.canonicalSlugName = slug.name;
      debug.app(`Slug name creation/update successful.`);
      return document;
    };
    return _updateSlug;
  },

  // Converts a source string (e.g., a team name, or a thing label) into a slug
  // or throws an error if this is not possible. String must be monolingual.
  generateSlugName(str) {
    if (typeof str !== 'string')
      throw new InvalidSlugStringError({
        message: 'Source string is undefined or not a string.'
      });

    str = str.trim();

    if (str === '')
      throw new InvalidSlugStringError({
        message: 'Source string cannot be empty.'
      });

    let slugName = unescapeHTML(str)
      .trim()
      .toLowerCase()
      .replace(/[?&"″'`’<>:]/g, '')
      .replace(/[ _/]/g, '-')
      .replace(/-{2,}/g, '-'); // Avoid consecutive hyphens

    if (!slugName)
      throw new InvalidSlugStringError({
        message: 'Source string %s cannot be converted to a valid slug.',
        messageParams: [str]
      }); // Expected depending on user input

    if (isUUID.v4(slugName))
      throw new InvalidSlugStringError({
        message: 'Source string cannot be a UUID.'
      });

    return slugName;
  }

};

class InvalidSlugStringError extends AbstractGenericError {}

class DuplicateSlugNameError extends AbstractGenericError {
  constructor(slug) {
    super({
      message: 'Slug name "%s" is already in use.',
      messageParams: [slug.name],
      payload: { slug }
    });
  }
}

module.exports = slugNameHelper;
