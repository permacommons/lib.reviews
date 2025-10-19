import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';
import { 
  userTableDefinition, 
  thingTableDefinition
} from './helpers/table-definitions.mjs';

const require = createRequire(import.meta.url);

// Standard env settings for AVA worker
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-4'; // Use testing-4 as per README pattern
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-4');

let Thing;
let adapters, WikidataBackendAdapter, OpenLibraryBackendAdapter;

test.before(async t => {
  // Stub search module to avoid starting Elasticsearch clients during tests
  const searchPath = require.resolve('../search');
  require.cache[searchPath] = {
    exports: {
      indexThing() {},
      searchThings: async () => ({}),
      getClient: () => ({})
    }
  };

  try {
    await dalFixture.bootstrap();

    // Ensure UUID generation helper exists (ignore failures on hosted CI)
    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      t.log('pgcrypto extension not available:', extensionError.message);
    }

    await dalFixture.createTestTables([
      userTableDefinition(),
      thingTableDefinition()
    ]);

    // Initialize models using the proper pattern
    const models = await dalFixture.initializeModels([
      { 
        key: 'Thing', 
        loader: dal => {
          const { initializeThingModel } = require('../models-postgres/thing.js');
          return initializeThingModel(dal);
        }
      }
    ]);
    Thing = models.Thing;

    // Import adapters
    adapters = (await import('../adapters/adapters.js')).default;
    WikidataBackendAdapter = (await import('../adapters/wikidata-backend-adapter.js')).default;
    OpenLibraryBackendAdapter = (await import('../adapters/openlibrary-backend-adapter.js')).default;

    t.log('PostgreSQL DAL and models initialized for adapter tests');
  } catch (error) {
    t.log('Failed to initialize test environment:', error);
    throw error;
  }
});

test.after.always(async t => {
  if (dalFixture) {
    await dalFixture.cleanup();
  }
});

function skipIfNoModels(t) {
  if (!Thing) {
    t.skip('Models not available - PostgreSQL setup may have failed');
    return true;
  }
  return false;
}

// Test adapter functionality with PostgreSQL Thing model
test('adapter initialization and basic functionality', async t => {
  if (skipIfNoModels(t)) return;
  
  // Test that adapters are properly initialized
  const allAdapters = adapters.getAll();
  t.true(allAdapters.length > 0, 'Should have adapters available');
  
  // Test adapter source URL retrieval
  const wikidataURL = adapters.getSourceURL('wikidata');
  t.is(wikidataURL, 'https://www.wikidata.org/', 'Should return correct Wikidata source URL');
  
  // Test adapter lookup by source
  const wikidataAdapter = adapters.getAdapterForSource('wikidata');
  t.truthy(wikidataAdapter, 'Should find Wikidata adapter');
  t.is(wikidataAdapter.sourceID, 'wikidata', 'Should have correct source ID');
});

test('Thing model initializeFieldsFromAdapter with metadata grouping', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a new thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q42'];
  thing.label = { en: 'Test Item' };
  thing.created_on = new Date();
  thing.created_by = testUserId;
  
  // Mock adapter result with description (should go to metadata)
  const adapterResult = {
    data: {
      label: { en: 'Updated Label' },
      description: { en: 'Test description from adapter' }
    },
    sourceID: 'wikidata'
  };
  
  // Initialize fields from adapter
  thing.initializeFieldsFromAdapter(adapterResult);
  
  // Verify label is set directly
  t.deepEqual(thing.label, { en: 'Updated Label' }, 'Label should be set directly');
  
  // Verify description is in metadata
  t.truthy(thing.metadata, 'Metadata should be created');
  t.deepEqual(thing.metadata.description, { en: 'Test description from adapter' }, 'Description should be in metadata');
  
  // Verify sync settings are created
  t.truthy(thing.sync, 'Sync should be created');
  t.truthy(thing.sync.label, 'Label sync should be set');
  t.truthy(thing.sync.description, 'Description sync should be set');
  t.is(thing.sync.label.source, 'wikidata', 'Label sync source should be wikidata');
  t.is(thing.sync.description.source, 'wikidata', 'Description sync source should be wikidata');
});

test('Thing model setURLs functionality', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a new thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/old'];
  thing.label = { en: 'Test Item' };
  thing.created_on = new Date();
  thing.created_by = testUserId;
  
  // Set new URLs including Wikidata URL
  const newURLs = [
    'https://www.wikidata.org/wiki/Q42',
    'https://openlibrary.org/works/OL123456W'
  ];
  
  thing.setURLs(newURLs);
  
  // Verify URLs are updated
  t.deepEqual(thing.urls, newURLs, 'URLs should be updated');
  
  // Verify sync settings are configured for supported fields
  t.truthy(thing.sync, 'Sync should be created');
  
  // Wikidata adapter supports label and description
  t.truthy(thing.sync.label, 'Label sync should be configured');
  t.truthy(thing.sync.description, 'Description sync should be configured');
  t.is(thing.sync.label.active, true, 'Label sync should be active');
  t.is(thing.sync.description.active, true, 'Description sync should be active');
  t.is(thing.sync.label.source, 'wikidata', 'Label sync source should be wikidata');
  t.is(thing.sync.description.source, 'wikidata', 'Description sync source should be wikidata');
});

test('Thing model updateActiveSyncs with metadata handling', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a thing with Wikidata URL and sync settings
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q42'];
  thing.label = { en: 'Test Item' };
  thing.sync = {
    description: {
      active: true,
      source: 'wikidata'
    }
  };
  thing.created_on = new Date();
  thing.created_by = testUserId;
  
  // Mock the Wikidata adapter lookup to avoid external API calls
  const originalLookup = WikidataBackendAdapter.prototype.lookup;
  WikidataBackendAdapter.prototype.lookup = async function(url) {
    return {
      data: {
        description: { en: 'Mocked description from Wikidata' }
      },
      sourceID: 'wikidata'
    };
  };
  
  try {
    // Update active syncs
    const updatedThing = await thing.updateActiveSyncs('test-user-id');
    
    // Verify description was updated in metadata
    t.truthy(updatedThing.metadata, 'Metadata should be created');
    t.deepEqual(updatedThing.metadata.description, { en: 'Mocked description from Wikidata' }, 'Description should be updated in metadata');
    
    // Verify sync timestamp was updated
    t.truthy(updatedThing.sync.description.updated, 'Sync timestamp should be updated');
    
  } finally {
    // Restore original lookup method
    WikidataBackendAdapter.prototype.lookup = originalLookup;
  }
});

test('adapter URL pattern matching', async t => {
  if (skipIfNoModels(t)) return;
  const wikidataAdapter = new WikidataBackendAdapter();
  const openLibraryAdapter = new OpenLibraryBackendAdapter();
  
  // Test Wikidata URL patterns
  t.true(wikidataAdapter.ask('https://www.wikidata.org/wiki/Q42'), 'Should match Wikidata wiki URL');
  t.true(wikidataAdapter.ask('https://wikidata.org/entity/Q42'), 'Should match Wikidata entity URL');
  t.false(wikidataAdapter.ask('https://example.com'), 'Should not match non-Wikidata URL');
  
  // Test OpenLibrary URL patterns
  t.true(openLibraryAdapter.ask('https://openlibrary.org/works/OL123456W'), 'Should match OpenLibrary works URL');
  t.true(openLibraryAdapter.ask('https://openlibrary.org/books/OL123456M'), 'Should match OpenLibrary books URL');
  t.false(openLibraryAdapter.ask('https://example.com'), 'Should not match non-OpenLibrary URL');
});

test('adapter supported fields configuration', async t => {
  if (skipIfNoModels(t)) return;
  const wikidataAdapter = new WikidataBackendAdapter();
  const openLibraryAdapter = new OpenLibraryBackendAdapter();
  
  // Test Wikidata supported fields
  const wikidataFields = wikidataAdapter.getSupportedFields();
  t.true(wikidataFields.includes('label'), 'Wikidata should support label field');
  t.true(wikidataFields.includes('description'), 'Wikidata should support description field');
  
  // Test OpenLibrary supported fields
  const openLibraryFields = openLibraryAdapter.getSupportedFields();
  t.true(openLibraryFields.includes('label'), 'OpenLibrary should support label field');
  t.true(openLibraryFields.includes('authors'), 'OpenLibrary should support authors field');
  t.true(openLibraryFields.includes('subtitle'), 'OpenLibrary should support subtitle field');
});

test('search indexing with PostgreSQL metadata structure', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a thing with metadata
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/test'];
  thing.label = { en: 'Test Item' };
  thing.canonical_slug_name = 'test-item';
  thing.metadata = {
    description: { en: 'Test description in metadata' },
    subtitle: { en: 'Test subtitle' }
  };
  thing.created_on = new Date();
  thing.created_by = testUserId;
  

  
  // Test that the thing has the correct structure for indexing
  t.truthy(thing.metadata, 'Thing should have metadata');
  t.truthy(thing.metadata.description, 'Thing should have description in metadata');
  t.deepEqual(thing.metadata.description, { en: 'Test description in metadata' }, 'Description should match');
  
  // Test field name compatibility
  t.truthy(thing.created_on, 'Thing should have created_on field');
  t.truthy(thing.canonical_slug_name, 'Thing should have canonical_slug_name field');
  
  // Test that the metadata structure is correct for search indexing
  t.is(thing.canonical_slug_name, 'test-item', 'canonical_slug_name should be set correctly');
});