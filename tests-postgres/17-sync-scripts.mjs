import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

const require = createRequire(import.meta.url);

// Standard env settings for AVA worker
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-6'; // Use testing-6 as per README pattern
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-6', { tableSuffix: 'sync_scripts' });

let Thing;
const ensureUserExists = async (id, name = 'Test User') => {
  const usersTable = dalFixture.getTableName('users');
  const displayName = name;
  const canonicalName = name.toUpperCase();
  await dalFixture.query(
    `INSERT INTO ${usersTable} (id, display_name, canonical_name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, displayName, canonicalName, `${id}@example.com`]
  );
};

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

    if (!dalFixture.isConnected()) {
      const reason = dalFixture.getSkipReason() || 'PostgreSQL not configured';
      t.log(`PostgreSQL not available, skipping sync script tests: ${reason}`);
      t.pass('Skipping tests - PostgreSQL not configured');
      return;
    }

    // Ensure UUID generation helper exists (ignore failures on hosted CI)
    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      t.log('pgcrypto extension not available:', extensionError.message);
    }

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

    t.log('PostgreSQL DAL and models initialized for sync script tests');
  } catch (error) {
    if (!dalFixture.isConnected()) {
      t.log('Failed to initialize test environment (PostgreSQL unavailable):', error.message || error);
      t.pass('Skipping tests - PostgreSQL not configured');
      return;
    }
    t.log('Failed to initialize test environment:', error);
    throw error;
  }
});

test.after.always(async t => {
  if (dalFixture) {
    await dalFixture.cleanup();
  }
});

test.beforeEach(async () => {
  await dalFixture.cleanupTables(['things', 'users']);
});

function skipIfNoModels(t) {
  if (!Thing) {
    const reason = dalFixture.getSkipReason() || 'PostgreSQL setup may have failed';
    t.log(`Models not available - ${reason}`);
    t.pass(`Skipping - ${reason}`);
    return true;
  }
  return false;
}

test.serial('sync scripts can be imported and work with PostgreSQL Thing model', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a test thing with Wikidata URL
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(testUserId, 'Sync Creator');
  
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
  if (skipIfNoModels(t)) return;
  
  // Create a test thing
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(testUserId, 'Sync Updater');
  
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
  if (skipIfNoModels(t)) return;
  
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
