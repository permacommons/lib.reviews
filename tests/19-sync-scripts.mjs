import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
import { ensureUserExists } from './helpers/dal-helpers-ava.mjs';

const require = createRequire(import.meta.url);

// Ensure the search mock is registered before loading the DAL bootstrap.
mockSearch();

const { setupPostgresTest } = await import('./helpers/setup-postgres-test.mjs');

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'sync_scripts',
  cleanupTables: ['things', 'users']
});

let Thing;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' }
  ]);
  Thing = models.Thing;
});

test.after.always(unmockSearch);

test.serial('sync scripts can be imported and work with PostgreSQL Thing model', async t => {
  
  // Create a test thing with Wikidata URL
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Sync Creator');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q42'];
  thing.label = { en: 'Test Item for Sync' };
  thing.sync = {
    description: {
      active: true,
      source: 'wikidata'
    }
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
  await thing.save();
  
  // Test that filterNotStaleOrDeleted works (used by sync scripts)
  const things = await Thing.filterNotStaleOrDeleted().run();
  t.true(Array.isArray(things), 'Should return an array of things');
  t.true(things.length >= 1, 'Should find at least our test thing');
  
  // Find our test thing
  const foundThing = things.find(t => t.id === thing.id);
  t.truthy(foundThing, 'Should find our test thing');
  t.deepEqual(foundThing.urls, ['https://www.wikidata.org/wiki/Q42'], 'URLs should match');
  
  // Test that setURLs works (used by sync scripts)
  foundThing.setURLs(foundThing.urls);
  t.truthy(foundThing.sync, 'Sync settings should be configured');
  t.truthy(foundThing.sync.description, 'Description sync should be configured');
  t.is(foundThing.sync.description.active, true, 'Description sync should be active');
  t.is(foundThing.sync.description.source, 'wikidata', 'Description sync source should be wikidata');
});

test.serial('sync functionality works with metadata grouping', async t => {
  
  // Create a test thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Sync Updater');
  
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://www.wikidata.org/wiki/Q123'];
  thing.label = { en: 'Sync Test Item' };
  thing.sync = {
    description: {
      active: true,
      source: 'wikidata'
    }
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
  await thing.save();
  
  // Mock the Wikidata adapter to simulate sync
  const WikidataBackendAdapter = (await import('../adapters/wikidata-backend-adapter.js')).default;
  const originalLookup = WikidataBackendAdapter.prototype.lookup;
  
  WikidataBackendAdapter.prototype.lookup = async function(url) {
    return {
      data: {
        description: { en: 'Synced description from Wikidata' }
      },
      sourceID: 'wikidata'
    };
  };
  
  try {
    // Test updateActiveSyncs (core sync functionality)
    const updatedThing = await thing.updateActiveSyncs(testUserId);
    

    
    // Verify description was synced to metadata
    t.truthy(updatedThing.metadata, 'Metadata should be created');
    t.truthy(updatedThing.metadata.description, 'Description should be in metadata');
    t.deepEqual(updatedThing.metadata.description, { en: 'Synced description from Wikidata' }, 'Description should be synced');
    
    // Verify sync timestamp was updated
    t.truthy(updatedThing.sync.description.updated, 'Sync timestamp should be updated');
    
  } finally {
    // Restore original lookup method
    WikidataBackendAdapter.prototype.lookup = originalLookup;
  }
});

test.serial('adapter integration with PostgreSQL Thing model', async t => {
  
  // Test that adapters can work with the PostgreSQL Thing model
  const adapters = (await import('../adapters/adapters.js')).default;
  
  // Test adapter discovery
  const allAdapters = adapters.getAll();
  t.true(allAdapters.length > 0, 'Should have adapters available');
  
  // Test Wikidata adapter
  const wikidataAdapter = adapters.getAdapterForSource('wikidata');
  t.truthy(wikidataAdapter, 'Should find Wikidata adapter');
  
  // Test URL pattern matching
  t.true(wikidataAdapter.ask('https://www.wikidata.org/wiki/Q42'), 'Should match Wikidata URL');
  t.false(wikidataAdapter.ask('https://example.com'), 'Should not match non-Wikidata URL');
  
  // Test supported fields
  const supportedFields = wikidataAdapter.getSupportedFields();
  t.true(supportedFields.includes('label'), 'Should support label field');
  t.true(supportedFields.includes('description'), 'Should support description field');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
