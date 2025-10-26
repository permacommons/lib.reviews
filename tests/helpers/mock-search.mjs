import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const searchPath = require.resolve('../../search');

export function mockSearch(indexedItems = []) {
  const captured = {
    searchQueries: [],
    mockSearchResponse: {
      hits: {
        hits: [],
        total: { value: 0 }
      }
    },
    indexedItems
  };

  const mock = {
    indexThing(thing) {
      if (thing._old_rev_of || thing._rev_deleted) {
        return Promise.resolve();
      }
      captured.indexedItems.push({ type: 'thing', data: thing });
      return Promise.resolve();
    },
    indexReview(review) {
      if (review._old_rev_of || review._rev_deleted) {
        return Promise.resolve();
      }
      captured.indexedItems.push({ type: 'review', data: review });
      return Promise.resolve();
    },
    searchThings(query, lang = 'en') {
      captured.searchQueries.push({ type: 'searchThings', query, lang });
      return Promise.resolve(captured.mockSearchResponse);
    },
    searchReviews(query, lang = 'en') {
      captured.searchQueries.push({ type: 'searchReviews', query, lang });
      return Promise.resolve(captured.mockSearchResponse);
    },
    suggestThing(prefix = '', lang = 'en') {
      captured.searchQueries.push({ type: 'suggestThing', prefix, lang });
      return Promise.resolve({ suggest: {} });
    },
    getClient: () => ({
      search: params => {
        captured.searchQueries.push({ type: 'rawSearch', params });
        return Promise.resolve(captured.mockSearchResponse);
      }
    }),
    createIndices: () => Promise.resolve(),
    deleteThing: () => Promise.resolve(),
    deleteReview: () => Promise.resolve(),
    close: () => {}
  };

  require.cache[searchPath] = {
    exports: mock
  };

  return captured;
}

export function unmockSearch() {
  delete require.cache[searchPath];
}