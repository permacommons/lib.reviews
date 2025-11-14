/**
 * There is a corresponding abstract frontend class in the frontend/ directory.
 * While similar, due to client/server differences and likely functional
 * divergence, we are keeping these separate.
 */

/**
 * Multilingual string as returned by adapters. Each language key maps to a string
 * value that MUST be in "HTML-safe text" format as described below.
 */
export interface AdapterMultilingualString {
  [lang: string]: string;
}

export interface AdapterLookupData {
  label: AdapterMultilingualString;
  description?: AdapterMultilingualString;
  subtitle?: AdapterMultilingualString;
  authors?: Array<AdapterMultilingualString>;
  /**
   * Optional domain object for native adapters. We keep the type generic here to
   * avoid pulling model types into all adapter consumers.
   */
  thing?: unknown;
}

export interface AdapterLookupResult {
  data: AdapterLookupData;
  sourceID: string;
}

export default abstract class AbstractBackendAdapter {
  /**
   * A short lower-case string, e.g., 'wikidata'
   */
  protected sourceID!: string;

  /**
   * The most canonical URL for the source
   */
  protected sourceURL!: string;

  /**
   * Regular expression which determines whether this adapter supports a given URL
   */
  protected supportedPattern!: RegExp;

  /**
   * Array of 'thing' properties this adapter supports (e.g., 'label', 'description')
   */
  protected supportedFields!: string[];

  /**
   * Minimum milliseconds to wait between requests to this adapter's API.
   * Set to 0 to disable throttling.
   */
  protected throttleMs: number = 0;

  /**
   * Timestamp of the last request made by this adapter instance
   */
  private lastRequestTime: number = 0;

  constructor() {
    if (new.target === AbstractBackendAdapter)
      throw new TypeError(
        'AbstractBackendAdapter is an abstract class, please instantiate a derived class.'
      );
  }

  /**
   * Does this adapter support a given URL?
   */
  ask(url: string): boolean {
    return this.supportedPattern.test(url);
  }

  /**
   * Promise that resolves when the adapter is ready for the next request.
   * Used to serialize requests and enforce throttling.
   */
  private throttlePromise: Promise<void> = Promise.resolve();

  /**
   * Internal lookup implementation to be provided by each adapter.
   * Do not call directly - use lookup() which handles throttling.
   *
   * ## Text Sanitization Requirements
   *
   * All text strings returned in AdapterMultilingualString objects MUST be in
   * "HTML-safe text" format:
   * - HTML entities are escaped (e.g., `&` → `&amp;`, `<` → `&lt;`)
   * - HTML tags are stripped/rejected
   * - Safe to render directly in HTML templates without additional escaping
   *
   * ### Recommended Pattern for External Data
   *
   * For text from external APIs, use this three-step sanitization:
   *
   * ```typescript
   * import { decodeHTML } from 'entities';
   * import escapeHTML from 'escape-html';
   * import stripTags from 'striptags';
   *
   * const safeText = escapeHTML(stripTags(decodeHTML(externalValue)));
   * ```
   *
   * This pattern:
   * 1. Decodes any existing entities to plain text
   * 2. Strips HTML tags
   * 3. Escapes entities for safe HTML storage
   *
   * Not all adapters need all three steps - adjust based on the format your
   * external API returns. If it already returns plain text with no entities
   * or tags, only `escapeHTML()` may be needed.
   */
  protected abstract _lookup(url: string): Promise<AdapterLookupResult>;

  /**
   * Perform a lookup for a given URL with automatic throttling.
   * Waits if necessary to respect the adapter's throttleMs setting.
   * Ensures requests are serialized per adapter instance, even with concurrent callers.
   * Implementations should override _lookup() instead of this method.
   */
  async lookup(url: string): Promise<AdapterLookupResult> {
    // Chain this request after the previous one completes
    const myTurn = this.throttlePromise.then(() => {
      // Mark when this request actually starts
      this.lastRequestTime = Date.now();
    });

    // Update the throttle promise to include this request + delay
    this.throttlePromise = myTurn.then(async () => {
      if (this.throttleMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.throttleMs));
      }
    });

    // Wait for our turn, then execute
    await myTurn;
    return this._lookup(url);
  }

  getSourceURL(): string {
    // Keep legacy fallback behavior
    return this.sourceURL || 'no source URL defined';
  }

  getSourceID(): string {
    // Keep legacy fallback behavior
    return this.sourceID || 'no source ID defined';
  }

  getSupportedFields(): string[] {
    return this.supportedFields || [];
  }
}
