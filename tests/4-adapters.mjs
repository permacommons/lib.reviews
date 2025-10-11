import test from 'ava';
import OpenLibraryBackendAdapter from '../adapters/openlibrary-backend-adapter.js';
import WikidataBackendAdapter from '../adapters/wikidata-backend-adapter.js';
import OpenStreetMapBackendAdapter from '../adapters/openstreetmap-backend-adapter.js';

// Standard env settings
process.env.NODE_ENV = 'development';
// Prevent config from installing file watchers that would leak handles under AVA.
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-4';

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
      let result;
      try {
        result = await tests[source].adapter.lookup(url);
      } catch (error) {
        t.fail(`Lookup failed for ${source} adapter URL ${url}: ${error.message || error.name}`);
        return;
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
