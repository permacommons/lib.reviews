import type { LookupResult, UpdateCallback } from '../../types/frontend/adapters.js';

/**
 * Adapter that, given a URL, looks up metadata that can identify a review
 * subject, such as a book's title or a restaurant name.
 *
 * @abstract
 */
export default abstract class AbstractLookupAdapter {
  /**
   * Canonical identifier for this source. Lower-case string, no whitespace.
   */
  sourceID?: string;

  /**
   * RegExp for URLs this adapter can handle.
   */
  supportedPattern?: RegExp;

  /**
   * Callback to run after a successful lookup
   */
  updateCallback: UpdateCallback | Function | null;

  /**
   * @param updateCallback - `(optional)` callback to run after a
   *  successful lookup
   */
  constructor(updateCallback?: UpdateCallback | Function | null) {
    // Replace w/ new.target after upgrading to Babel 7.0
    if (this.constructor.name === AbstractLookupAdapter.name)
      throw new TypeError('AbstractAdapter is an abstract class, please instantiate a derived class.');

    this.updateCallback = updateCallback || null;
  }

  /**
   * Does this adapter support the given URL? By default, performs a simple
   * regex check.
   *
   * @param url - the URL to test
   * @returns true if supported
   */
  ask(url: string): boolean {
    return this.supportedPattern?.test(url) ?? false;
  }

  /**
   * Perform a lookup for a given URL.
   *
   * @abstract
   * @param _url - the URL to perform lookup for
   * @returns promise that resolves with a {@link LookupResult} on success,
   *  and rejects with an error on failure
   */
  lookup(_url: string): Promise<LookupResult> {
    return Promise.reject(new Error('Not implemented.'));
  }

  /**
   * Return the canonical source identifier for this adapter
   *
   * @returns the source ID
   */
  getSourceID(): string {
    return this.sourceID || 'no source ID defined';
  }
}
