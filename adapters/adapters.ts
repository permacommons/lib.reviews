import debug from '../util/debug.ts';
import AbstractBackendAdapter, { type AdapterLookupResult } from './abstract-backend-adapter.ts';
import OpenLibraryBackendAdapter from './openlibrary-backend-adapter.ts';
import OpenStreetMapBackendAdapter from './openstreetmap-backend-adapter.ts';
import WikidataBackendAdapter from './wikidata-backend-adapter.ts';

type BackendAdapter = AbstractBackendAdapter;

const wikidata = new WikidataBackendAdapter();
const openLibrary = new OpenLibraryBackendAdapter();
const openStreetMap = new OpenStreetMapBackendAdapter();
const adapters: BackendAdapter[] = [wikidata, openLibrary, openStreetMap];

const sourceURLs: Record<string, string> = {};
for (const adapter of adapters) sourceURLs[adapter.getSourceID()] = adapter.getSourceURL();

/**
 * General helper functions for adapters that obtain metadata about specific URLs.
 */
const adaptersAPI = {
  /**
   * Return the adapter instances in use, in deterministic order.
   */
  getAll(): BackendAdapter[] {
    return adapters;
  },

  /**
   * Returns the canonical URL that represents a specific source, typically
   * a project's main website. Used for "About this source" links and such.
   */
  getSourceURL(sourceID: string): string | undefined {
    return sourceURLs[sourceID];
  },

  /**
   * Returns the adapter that handles a specific source (undefined if not found).
   */
  getAdapterForSource(sourceID: string): BackendAdapter | undefined {
    for (const adapter of adapters) if (adapter.getSourceID() === sourceID) return adapter;
    return undefined;
  },

  /**
   * Return a lookup promise from every adapter that can support metadata
   * about this URL. Each promise is wrapped to never reject.
   */
  getSupportedLookupsAsSafePromises(
    url: string
  ): Array<Promise<AdapterLookupResult | { error: unknown }>> {
    const p: Array<Promise<AdapterLookupResult | { error: unknown }>> = [];
    for (const adapter of adapters) {
      if (adapter.ask(url))
        p.push(
          adapter.lookup(url).catch(error => {
            debug.error({ error });
            return { error };
          })
        );
    }
    return p;
  },

  /**
   * Helper function to use in combination with Promise.all lookups.
   * Returns the first result that contains a data object with a label.
   */
  getFirstResultWithData(results: unknown[]): AdapterLookupResult | undefined {
    let firstResultWithData: AdapterLookupResult | undefined;
    for (const adapterResult of results as any[]) {
      if (
        adapterResult &&
        typeof adapterResult === 'object' &&
        'data' in adapterResult &&
        adapterResult.data &&
        typeof adapterResult.data === 'object' &&
        (adapterResult.data as any).label
      ) {
        firstResultWithData = adapterResult as AdapterLookupResult;
        break;
      }
    }
    return firstResultWithData;
  },
} as const;

export default adaptersAPI;
