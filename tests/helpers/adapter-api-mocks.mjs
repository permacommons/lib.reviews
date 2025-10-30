import nock from 'nock';
import { URL } from 'node:url';
import { URLSearchParams } from 'node:url';

const OPENLIBRARY_HOST = 'https://openlibrary.org';
const WIKIDATA_HOST = 'https://www.wikidata.org';
const OVERPASS_HOST = 'https://overpass-api.de';

// These payloads mirror the minimal fields each adapter expects from its remote API.
const openLibraryWorksData = {
  OL16239864W: {
    title: 'The Storytelling Animal',
    languages: [{ key: '/languages/eng' }],
    authors: [{ author: { key: '/authors/OL12345A' } }]
  },
  OL0W: {} // Returns empty payload to trigger "no data" branch
};

const openLibraryBooksData = {
  OL25087046M: {
    title: 'The Storytelling Animal (Edition)',
    subtitle: 'Making Sense of Stories',
    languages: [{ key: '/languages/eng' }],
    authors: [{ key: '/authors/OL67890A' }]
  },
  OL0M: {} // Empty payload for no-data scenario
};

const openLibraryAuthorsData = {
  '/authors/OL12345A': { name: 'Jonathan Gottschall' },
  '/authors/OL67890A': { name: 'Mock Author' }
};

const wikidataEntities = {
  Q4921967: buildWikidataEntity('Q4921967', 'Wikidata Entity 4921967', 'An example entity'),
  Q33205191: buildWikidataEntity('Q33205191', 'Wikidata Entity 33205191', 'Another example entity'),
  Q0: buildEmptyWikidataEntity('Q0')
};

// Overpass combines coordinates and tag data; we only need the tag payload.
const overpassResponses = {
  'way(540846325)': buildOverpassElement('Sample Way', { en: 'Sample Way EN', de: 'Beispielstraße' }),
  'node(4809608023)': buildOverpassElement('Sample Node', { en: 'Sample Node EN' }),
  'way(343)': { elements: [] }
};

function buildWikidataEntity(id, label, description) {
  return {
    success: 1,
    entities: {
      [id]: {
        labels: {
          en: { language: 'en', value: label },
          de: { language: 'de', value: `${label} (DE)` }
        },
        descriptions: {
          en: { language: 'en', value: description }
        }
      }
    }
  };
}

function buildEmptyWikidataEntity(id) {
  return {
    success: 1,
    entities: {
      [id]: {
        labels: {},
        descriptions: {}
      }
    }
  };
}

function buildOverpassElement(name, localizedNames = {}) {
  const tags = {
    name
  };
  for (const [language, value] of Object.entries(localizedNames))
    tags[`name:${language}`] = value;
  return {
    elements: [
      {
        tags
      }
    ]
  };
}

// We still need Elasticsearch/PostgreSQL connections, so allow localhost traffic.
function allowLocalhost() {
  nock.enableNetConnect(host => {
    if (!host)
      return false;
    const normalized = host.split(':')[0];
    return ['localhost', '127.0.0.1', '::1'].includes(normalized);
  });
}

function setupOpenLibraryMocks() {
  nock(OPENLIBRARY_HOST)
    .persist()
    .get(/\/works\/([^/]+)\.json/)
    .reply((uri) => {
      const id = uri.match(/\/works\/([^/.]+)\.json/)[1];
      const payload = openLibraryWorksData[id];
      if (payload)
        return [200, payload];
      return [404, {}];
    });

  nock(OPENLIBRARY_HOST)
    .persist()
    .get(/\/books\/([^/]+)\.json/)
    .reply((uri) => {
      const id = uri.match(/\/books\/([^/.]+)\.json/)[1];
      const payload = openLibraryBooksData[id];
      if (payload)
        return [200, payload];
      return [404, {}];
    });

  nock(OPENLIBRARY_HOST)
    .persist()
    .get(/\/authors\/[^/]+\.json/)
    .reply((uri) => {
      const key = uri.replace(/\.json$/, '');
      const payload = openLibraryAuthorsData[key];
      if (payload)
        return [200, payload];
      return [404, {}];
    });
}

function setupWikidataMocks() {
  nock(WIKIDATA_HOST)
    .persist()
    .get('/w/api.php')
    .query(true)
    .reply((uri) => {
      const { searchParams } = new URL(uri, WIKIDATA_HOST);
      const id = (searchParams.get('ids') || '').toUpperCase();
      const payload = wikidataEntities[id];
      if (payload)
        return [200, payload];
      return [
        404,
        {
          success: 0,
          error: { code: 'not-found', info: `Unknown entity ${id}` }
        }
      ];
    });
}

function parseOverpassRequestBody(requestBody) {
  if (!requestBody)
    return '';
  if (Buffer.isBuffer(requestBody))
    return parseOverpassRequestBody(requestBody.toString());
  if (typeof requestBody === 'string') {
    const params = new URLSearchParams(requestBody);
    return params.get('data') || '';
  }
  if (typeof requestBody === 'object' && requestBody.data)
    return requestBody.data;
  return '';
}

function setupOverpassMocks() {
  nock(OVERPASS_HOST)
    .persist()
    .post('/api/interpreter')
    .reply((uri, requestBody) => {
      const dataQuery = parseOverpassRequestBody(requestBody);
      const key = Object.keys(overpassResponses).find(candidate => dataQuery.includes(candidate));
      if (key)
        return [200, overpassResponses[key]];
      return [200, { elements: [] }];
    });
}

export function setupAdapterApiMocks() {
  nock.disableNetConnect();
  allowLocalhost();
  setupOpenLibraryMocks();
  setupWikidataMocks();
  setupOverpassMocks();
}

export function teardownAdapterApiMocks() {
  nock.cleanAll();
  nock.enableNetConnect();
}
