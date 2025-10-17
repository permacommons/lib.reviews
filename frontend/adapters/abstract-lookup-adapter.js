/**
 * Adapter that, given a URL, looks up metadata that can identify a review
 * subject, such as a book's title or a restauraunt name.
 *
 * @abstract
 */
export default class AbstractLookupAdapter {

  /**
   * Lookup adapters return a limited set of data that's displayed to the
   * user. Lookup results take the following form. Note that strings are stored
   * only in one language; the backend adapter performs the full lookup of all
   * available translations.
   *
   * @typedef {Object} LookupResult
   * @property {Object} data
   *  data for this result
   * @property {String} data.label
   *  name to be rendered for this result
   * @property {String} [data.subtitle]
   *  subtitle to be shown below label
   * @property {String} [data.description]
   *  short textual description
   * @property {Thing} [data.thing]
   *  native object representing the review subject, used by native lookup adapter
   * @property {String} sourceID
   *  canonical source that identifies this adapter
   */

  /**
   * @param {Function} updateCallback - `(optional)` callback to run after a
   *  successful lookup
   */
  constructor(updateCallback) {
    // Replace w/ new.target after upgrading to Babel 7.0
    if (this.constructor.name === AbstractLookupAdapter.name)
      throw new TypeError('AbstractAdapter is an abstract class, please instantiate a derived class.');

    this.updateCallback = updateCallback || null;

    /**
     * Canonical identifier for this source. Lower-case string, no whitespace.
     *
     * @type {String}
     */
    this.sourceID = undefined;

    /**
     * RegExp for URLs this adapter can handle.
     *
     * @type {RegExp}
     */
    this.supportedPattern = undefined;
  }

  /**
   * Does this adapter support the given URL? By default, performs a simple
   * regex check.
   *
   * @param {String} url
   *  the URL to test
   * @returns {Boolean}
   *  true if supported
   */
  ask(url) {
    return this.supportedPattern.test(url);
  }

  /**
   * Perform a lookup for a given URL.
   *
   * @abstract
   * @param {String} _url
   *  the URL to perform lookup for
   * @returns {Promise}
   *  promise that resolves with a result object of the form
   *  {@link LookupResult} on success, and rejects with an error on failure
   *
   */
  lookup(_url) {
    return Promise.reject(new Error('Not implemented.'));
  }

  /**
   * Return the canonical source identifier for this adapter
   *
   * @returns {String}
   */
  getSourceID() {
    return this.sourceID || 'no source ID defined';
  }

}
