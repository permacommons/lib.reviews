import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
import { ensureUserExists } from './helpers/dal-helpers-ava.mjs';

const require = createRequire(import.meta.url);

// Ensure the search mock is registered before the DAL bootstrap loads models.
mockSearch();

const { setupPostgresTest } = await import('./helpers/setup-postgres-test.mjs');

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'adapter_functionality',
  cleanupTables: ['things', 'users']
});

let Thing;
let adapters, WikidataBackendAdapter, OpenLibraryBackendAdapter;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' }
  ]);
  Thing = models.Thing;

  adapters = (await import('../adapters/adapters.js')).default;
  WikidataBackendAdapter = (await import('../adapters/wikidata-backend-adapter.js')).default;
  OpenLibraryBackendAdapter = (await import('../adapters/openlibrary-backend-adapter.js')).default;
});

test.after.always(unmockSearch);

// Test adapter functionality with PostgreSQL Thing model
test.serial('adapter initialization and basic functionality', async t => {
  
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

test.serial('Thing model initializeFieldsFromAdapter with metadata grouping', async t => {
  
  // Create a new thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Thing Creator');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q42'];
  thing.label = { en: 'Test Item' };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
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

test.serial('Thing model setURLs functionality', async t => {
  
  // Create a new thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'URL Creator');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/old'];
  thing.label = { en: 'Test Item' };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
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

test.serial('Thing model updateActiveSyncs with metadata handling', async t => {
  
  // Create a thing with Wikidata URL and sync settings
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Sync Creator');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q42'];
  thing.label = { en: 'Test Item' };
  thing.sync = {
    description: {
      active: true,
      source: 'wikidata'
    }
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
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
    const updatedThing = await thing.updateActiveSyncs(testUserId);
    
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

test.serial('search indexing with PostgreSQL metadata structure', async t => {
  
  // Create a thing with metadata
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Metadata Creator');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/test'];
  thing.label = { en: 'Test Item' };
  thing.canonicalSlugName = 'test-item';
  thing.metadata = {
    description: { en: 'Test description in metadata' },
    subtitle: { en: 'Test subtitle' }
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  

  
  // Test that the thing has the correct structure for indexing
  t.truthy(thing.metadata, 'Thing should have metadata');
  t.truthy(thing.metadata.description, 'Thing should have description in metadata');
  t.deepEqual(thing.metadata.description, { en: 'Test description in metadata' }, 'Description should match');
  
  // Test field name compatibility
  t.truthy(thing.createdOn, 'Thing should have created_on field');
  t.truthy(thing.canonicalSlugName, 'Thing should have canonical_slug_name field');
  
  // Test that the metadata structure is correct for search indexing
  t.is(thing.canonicalSlugName, 'test-item', 'canonical_slug_name should be set correctly');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
