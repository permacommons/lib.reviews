import type { SearchParams, SearchResponse } from 'elasticsearch';

type LocaleCode = LibReviews.LocaleCode;
type SearchModule = typeof import('../../search.ts').default;

type RevisionAwareRecord = Record<string, unknown> & {
  _oldRevOf?: unknown;
  _revDeleted?: boolean;
  _old_rev_of?: unknown;
  _rev_deleted?: boolean;
  _data?: {
    _old_rev_of?: unknown;
    _rev_deleted?: boolean;
  };
};
type MLText = Record<string, string>;

export type ThingIndexShape = RevisionAwareRecord & {
  id?: string;
  urls?: string[];
  urlID?: string;
  label?: MLText;
  aliases?: MLText;
  metadata?: {
    description?: MLText;
    subtitle?: MLText;
    authors?: Array<Record<string, unknown>>;
  };
};

export type ReviewIndexShape = RevisionAwareRecord & {
  id?: string;
  thingID?: string;
  title?: MLText;
  text?: MLText;
  html?: MLText;
  starRating?: number;
};

export type MockIndexedItem =
  | { type: 'thing'; data: ThingIndexShape }
  | { type: 'review'; data: ReviewIndexShape };

export function isThingItem(
  item: MockIndexedItem
): item is { type: 'thing'; data: ThingIndexShape } {
  return item.type === 'thing';
}

export function isReviewItem(
  item: MockIndexedItem
): item is { type: 'review'; data: ReviewIndexShape } {
  return item.type === 'review';
}

export type MockSearchQuery =
  | { type: 'searchThings'; query: string; lang: LocaleCode }
  | { type: 'searchReviews'; query: string; lang: LocaleCode }
  | { type: 'suggestThing'; prefix: string; lang: LocaleCode }
  | { type: 'rawSearch'; params: SearchParams };

export type MockSearchResponse<TDocument = Record<string, unknown>> = {
  took: number;
  timed_out: boolean;
  _shards: {
    total: number;
    successful: number;
    failed: number;
    skipped: number;
  };
  hits: {
    hits: Array<Record<string, unknown> & { _source?: TDocument }>;
    total: { value: number; relation?: 'eq' | 'gte' };
    max_score?: number | null;
  };
  suggest: Record<string, unknown>;
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
      failed: 0,
      skipped: 0,
    },
    hits: {
      hits: [],
      total: { value: 0, relation: 'eq' as const },
      max_score: null,
    },
    suggest: {},
  } as MockSearchResponse<TDocument>;

  const captured: MockSearchCapture<TDocument> = {
    searchQueries: [],
    mockSearchResponse,
    indexedItems: [...initialIndexedItems],
  };

  const mock: Partial<SearchModule> = {
    _raw: async <TResponse = unknown>(params: SearchParams): Promise<SearchResponse<TResponse>> => {
      captured.searchQueries.push({ type: 'rawSearch', params });
      return captured.mockSearchResponse as unknown as SearchResponse<TResponse>;
    },
    indexThing: async (thing: RevisionAwareRecord) => {
      if (
        thing._oldRevOf ||
        thing._revDeleted ||
        thing._old_rev_of ||
        thing._rev_deleted ||
        (thing._data && (thing._data._old_rev_of || thing._data._rev_deleted))
      ) {
        return;
      }
      captured.indexedItems.push({ type: 'thing', data: thing });
    },
    indexReview: async (review: RevisionAwareRecord) => {
      if (
        review._oldRevOf ||
        review._revDeleted ||
        review._old_rev_of ||
        review._rev_deleted ||
        (review._data && (review._data._old_rev_of || review._data._rev_deleted))
      ) {
        return;
      }
      captured.indexedItems.push({ type: 'review', data: review });
    },
    searchThings: async (query: string, lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'searchThings', query, lang });
      return captured.mockSearchResponse as unknown as SearchResponse<any>;
    },
    searchReviews: async (query: string, lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'searchReviews', query, lang });
      return captured.mockSearchResponse as unknown as SearchResponse<any>;
    },
    suggestThing: async (prefix = '', lang: LocaleCode = 'en') => {
      captured.searchQueries.push({ type: 'suggestThing', prefix, lang });
      return captured.mockSearchResponse as unknown as SearchResponse<any>;
    },
    createIndices: async () => {},
    deleteThing: async () => {},
    deleteReview: async () => {},
    close: () => {},
  };

  Object.assign(searchModule as Record<string, unknown>, mock as Record<string, unknown>);

  return captured;
}

export function unmockSearch(): void {
  for (const [key, value] of originalSearchEntries) {
    (searchModule as Record<string, unknown>)[key] = value;
  }
}
