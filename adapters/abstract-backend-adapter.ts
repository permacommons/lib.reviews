/**
 * There is a corresponding abstract frontend class in the frontend/ directory.
 * While similar, due to client/server differences and likely functional
 * divergence, we are keeping these separate.
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

  constructor() {
    if (new.target === AbstractBackendAdapter)
      throw new TypeError('AbstractBackendAdapter is an abstract class, please instantiate a derived class.');
  }

  /**
   * Does this adapter support a given URL?
   */
  ask(url: string): boolean {
    return this.supportedPattern.test(url);
  }

  /**
   * Perform a lookup for a given URL.
   * Implementations should resolve with an object of the form:
   * {
   *   data: {
   *     label: Record<string, string> (required)
   *     description?: Record<string, string>
   *     subtitle?: Record<string, string>
   *     authors?: Array<Record<string, string>>
   *     thing?: unknown
   *   },
   *   sourceID: string
   * }
   */
  abstract lookup(url: string): Promise<AdapterLookupResult>;

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