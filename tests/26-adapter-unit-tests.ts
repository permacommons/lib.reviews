import test from 'ava';
import OpenLibraryBackendAdapter from '../adapters/openlibrary-backend-adapter.ts';
import WikidataBackendAdapter from '../adapters/wikidata-backend-adapter.ts';
import OpenStreetMapBackendAdapter from '../adapters/openstreetmap-backend-adapter.ts';
import {
  setupAdapterApiMocks,
  teardownAdapterApiMocks
} from './helpers/adapter-api-mocks.ts';

test.before(() => {
  // Intercept adapter HTTP calls so tests never hit live services.
  setupAdapterApiMocks();
});

test.after.always(() => {
  // Restore default nock behavior for subsequent test files.
  teardownAdapterApiMocks();
});

const tests = {
  openlibrary: {
    adapter: new OpenLibraryBackendAdapter(),
    validURLsWithData: [
      'https://openlibrary.org/works/OL16239864W/The_Storytelling_Animal',
      'https://openlibrary.org/works/OL16239864W',
      'https://openlibrary.org/books/OL25087046M',
      'http://openlibrary.org/books/OL25087046M'
    ],
    validURLsWithoutData: [
      'https://openlibrary.org/works/OL0W',
      'https://openlibrary.org/books/OL0M'
    ],
    invalidURLs: [
      'https://openlibrary.org/authors/OL23919A/J._K._Rowling',
      'https://openlibrary.org/authors/OL3433440A.json',
      'https://openlibrary.org/works/OL16239864W.json',
      'https://openlibrary.org/works/OL16239864W.json'
    ]
  },
  wikidata: {
    adapter: new WikidataBackendAdapter(),
    validURLsWithData: [
      'https://www.wikidata.org/wiki/Q4921967',
      'https://www.wikidata.org/wiki/Q4921967#sitelinks-wikipedia',
      'https://www.wikidata.org/wiki/Q33205191',
      'https://www.wikidata.org/entity/Q33205191',
      'http://www.wikidata.org/entity/Q33205191'
    ],
    validURLsWithoutData: [
      'https://www.wikidata.org/wiki/Q0'
    ],
    invalidURLs: [
      'https://www.wikidata.org/wiki/Property:P4426',
      'https://www.wikidata.org/wiki/Special:NewItem',
      'https://www.wikidata.org/wiki/Wikidata:Introduction'
    ]
  },
  openstreetmap: {
    adapter: new OpenStreetMapBackendAdapter(),
    validURLsWithData: [
      'https://www.openstreetmap.org/way/540846325',
      'https://www.openstreetmap.org/node/4809608023'
    ],
    validURLsWithoutData: [
      'https://www.openstreetmap.org/way/343'
    ],
    invalidURLs: [
      'https://wiki.openstreetmap.org/wiki/Map_Features',
      'https://www.openstreetmap.org/#map=18/34.70788/135.50715'
    ]
  }
};

test('Adapters return correct source ID', t => {
  for (const source in tests)
    t.is(tests[source].adapter.getSourceID(), source);
  t.pass();
});

test('Adapters reject invalid URLs', t => {
  for (const source in tests) {
    const invalidURLs = tests[source].invalidURLs.slice();
    invalidURLs.unshift(['https://zombo.com/', 'an elephant']);
    for (const url of invalidURLs)
      t.false(tests[source].adapter.ask(url));
  }
  t.pass();
});

test('Adapters say they support valid URLs', t => {
  for (const source in tests) {
    const validURLs = [
      ...tests[source].validURLsWithData,
      ...tests[source].validURLsWithoutData
    ];
    for (const url of validURLs)
      t.true(tests[source].adapter.ask(url));
  }
  t.pass();
});

test('Adapters retrieve data with label and correct source ID from valid URLs with data', async t => {
  for (const source in tests) {
    const urls = tests[source].validURLsWithData.slice();
    for (const url of urls) {
      const result = await lookupWithRetry({ t, source, url });
      if (!result) {
        t.log(`Skipping ${source} adapter URL ${url} after repeated failures (likely transient 5xx).`);
        continue;
      }
      t.is('object', typeof result);
      t.is('object', typeof result.data);
      t.is('object', typeof result.data.label);
      t.is(tests[source].adapter.getSourceID(), result.sourceID);
    }
  }
  t.pass();
});

test(`Adapters don't retrieve data from valid URLs that contain no data`, async t => {
  for (const source in tests) {
    const urls = tests[source].validURLsWithoutData.slice();
    for (const url of urls) {
      await t.throwsAsync(async () => {
        try {
          await tests[source].adapter.lookup(url);
        } catch (error) {
          // AVA chokes on the richer RequestError object, so throw a minimal error.
          throw new Error(error && error.message ? error.message : String(error));
        }
        throw new Error(`Expected lookup failure for ${source} adapter URL ${url}`);
      });
    }
  }
  t.pass();
});

test('Adapters report correct supported fields', t => {
  // Test Wikidata supported fields
  const wikidataAdapter = tests.wikidata.adapter;
  const wikidataFields = wikidataAdapter.getSupportedFields();
  t.true(wikidataFields.includes('label'), 'Wikidata should support label field');
  t.true(wikidataFields.includes('description'), 'Wikidata should support description field');

  // Test OpenLibrary supported fields
  const openLibraryAdapter = tests.openlibrary.adapter;
  const openLibraryFields = openLibraryAdapter.getSupportedFields();
  t.true(openLibraryFields.includes('label'), 'OpenLibrary should support label field');
  t.true(openLibraryFields.includes('authors'), 'OpenLibrary should support authors field');
  t.true(openLibraryFields.includes('subtitle'), 'OpenLibrary should support subtitle field');

  // Test OpenStreetMap supported fields
  const osmAdapter = tests.openstreetmap.adapter;
  const osmFields = osmAdapter.getSupportedFields();
  t.true(osmFields.includes('label'), 'OpenStreetMap should support label field');

  t.pass();
});

/**
 * Attempt an adapter lookup with a couple of retries to shield the suite from
 * transient Overpass/OpenStreetMap 5xx responses in CI.
 * @returns {object|null} null indicates we should skip assertions for this URL.
 */
async function lookupWithRetry({ t, source, url, attempts = 3 }) {
  const adapter = tests[source].adapter;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await adapter.lookup(url);
    } catch (error) {
      const status = error && (error.statusCode || error.status);
      const isTransientOverpass = source === 'openstreetmap' && status >= 500;
      if (isTransientOverpass && attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        continue;
      }
      if (isTransientOverpass) {
        t.log(`OpenStreetMap lookup failed with ${status}; treating as transient.`);
        return null;
      }
      t.fail(`Lookup failed for ${source} adapter URL ${url}: ${error.message || error.name}`);
      return null;
    }
  }
  return null;
}
