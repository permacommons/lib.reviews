import debug from '../util/debug.js';
import WikidataBackendAdapter from './wikidata-backend-adapter.js';
import OpenLibraryBackendAdapter from './openlibrary-backend-adapter.js';
import OpenStreetMapBackendAdapter from './openstreetmap-backend-adapter.js';

const wikidata = new WikidataBackendAdapter();
const openLibrary = new OpenLibraryBackendAdapter();
const openStreetMap = new OpenStreetMapBackendAdapter();
const adapters = [wikidata, openLibrary, openStreetMap];
const sourceURLs = {};
for (const adapter of adapters)
  sourceURLs[adapter.getSourceID()] = adapter.getSourceURL();

// General helper functions for adapters that obtain metadata about specific
// URLs

const adaptersAPI = {

    getAll() {
      return adapters;
    },

    // Returns the canonical URL that represents a specific source, typically
    // a project's main website. Used for "About this source" links and such.
    getSourceURL(sourceID) {
      return sourceURLs[sourceID];
    },

    // Returns the adapter that handles a specific source (undefined if not found)
    getAdapterForSource(sourceID) {
      for (let adapter of adapters)
        if (adapter.sourceID === sourceID)
          return adapter;
    },

    // Return a lookup promise from every adapter that can support metadata
    // about this URL.
    getSupportedLookupsAsSafePromises(url) {
      const p = [];
      for (const adapter of adapters) {
        if (adapter.ask(url))
          p.push(adapter.lookup(url).catch(error => {
            debug.error({ error });
            return { error };
          }));
      }
      return p;
    },

    // Helper function to use in combination with Promise.all lookups
    getFirstResultWithData(results) {
      let firstResultWithData;
      for (let adapterResult of results) {
        if (typeof adapterResult === 'object' &&
          adapterResult.data && adapterResult.data.label) {
            firstResultWithData = adapterResult;
            break;
          }
      }
      return firstResultWithData;
    }
};

export default adaptersAPI;
