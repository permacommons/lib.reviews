import type { SearchParams, SearchResponse } from 'elasticsearch';

type LocaleCode = LibReviews.LocaleCode;
type SearchModule = typeof import('../../search.ts').default;

type RevisionAwareRecord = Record<string, unknown> & {
  _old_rev_of?: unknown;
  _rev_deleted?: boolean;
};

export type MockIndexedItem =
  | { type: 'thing'; data: RevisionAwareRecord }
  | { type: 'review'; data: RevisionAwareRecord };

export type MockSearchQuery =
  | { type: 'searchThings'; query: string; lang: LocaleCode }
  | { type: 'searchReviews'; query: string; lang: LocaleCode }
  | { type: 'suggestThing'; prefix: string; lang: LocaleCode }
  | { type: 'rawSearch'; params: SearchParams };

export type MockSearchResponse<TDocument = Record<string, unknown>> = SearchResponse<TDocument> & {
  hits: {
    hits: Array<Record<string, unknown> & { _source?: TDocument }>;
    total: { value: number };
  };
};

export interface MockSearchCapture<TDocument = Record<string, unknown>> {
  searchQueries: MockSearchQuery[];
  mockSearchResponse: MockSearchResponse<TDocument>;
  indexedItems: MockIndexedItem[];
}

const { default: searchModule } = await import('../../search.ts');

const originalSearchEntries = Object.entries(searchModule) as Array<
  [keyof SearchModule, SearchModule[keyof SearchModule]]
>;

export function mockSearch<TDocument = Record<string, unknown>>(
  initialIndexedItems: MockIndexedItem[] = []
): MockSearchCapture<TDocument> {
  const mockSearchResponse = {
    took: 0,
    timed_out: false,
    _shards: {
      total: 0,
      successful: 0,
      failed: 0
    },
    hits: {
      hits: [],
      total: { value: 0 }
    },
    suggest: {}
  } as MockSearchResponse<TDocument>;

  const captured: MockSearchCapture<TDocument> = {
    searchQueries: [],
    mockSearchResponse,
    indexedItems: [...initialIndexedItems]
  };

  const mock: Partial<SearchModule> = {
    _raw: async (params: SearchParams) => {
      captured.searchQueries.push({ type: 'rawSearch', params });
      return captured.mockSearchResponse;
    },
    indexThing: async (thing: RevisionAwareRecord) => {
      if (thing._old_rev_of || thing._rev_deleted) {
        return;
      }
      captured.indexedItems.push({ type: 'thing', data: thing });
    },
    indexReview: async (review: RevisionAwareRecord) => {
      if (review._old_rev_of || review._rev_deleted) {
        return;
      }
      captured.indexedItems.push({ type: 'review', data: review });
    },
    searchThings: async (query: string, lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'searchThings', query, lang });
      return captured.mockSearchResponse;
    },
    searchReviews: async (query: string, lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'searchReviews', query, lang });
      return captured.mockSearchResponse;
    },
    suggestThing: async (prefix = '', lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'suggestThing', prefix, lang });
      return captured.mockSearchResponse;
    },
    createIndices: async () => {},
    deleteThing: async () => {},
    deleteReview: async () => {},
    close: () => {}
  };

  Object.assign(searchModule as Record<string, unknown>, mock as Record<string, unknown>);

  return captured;
}

export function unmockSearch(): void {
  for (const [key, value] of originalSearchEntries) {
    (searchModule as Record<string, unknown>)[key] = value;
  }
}
