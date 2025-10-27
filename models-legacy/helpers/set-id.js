'use strict';
const thinky = require('../../db');
const r = thinky.r;

/**
 * Small utility module for IDs.
 *
 * @namespace SetID
 */

/**
 * Get a handler that can be attached to a Thinky model as an instance method,
 * and that obtains a UUID to a document and assigns it, but does not save.
 *
 * This is occasionally useful when we want to get an ID before saving.
 *
 * @memberof SetID
 * @returns {Function}
 *   See {@link SetID~_setID}.
 */
function getSetIDHandler() {

  /**
   * Obtain a UUID and assign it to the object as the `.id` property.
   *
   * @returns {model}
   *  document of the model this handler was assigned to, with ID set, or
   *  unmodified if it already had one
   * @memberof SetID
   * @inner
   * @this model
   */
  const _setID = async function() {
    let document = this;
    if (!document.id)
      document.id = await r.uuid();
    return document;
  };
  return _setID;

}

module.exports = getSetIDHandler;
