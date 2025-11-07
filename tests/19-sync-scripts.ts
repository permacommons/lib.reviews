import test from 'ava';
import { randomUUID } from 'crypto';
import type { AdapterLookupResult } from '../adapters/abstract-backend-adapter.ts';
import { ensureUserExists } from './helpers/dal-helpers-ava.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';

type ThingModel = typeof import('../models/thing.ts').default;

// Ensure the search mock is registered before loading the DAL bootstrap.
mockSearch();

type SetupPostgresTestFn = typeof import('./helpers/setup-postgres-test.ts')['setupPostgresTest'];
const { setupPostgresTest } = (await import('./helpers/setup-postgres-test.ts')) as {
  setupPostgresTest: SetupPostgresTestFn;
};

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'sync_scripts',
  cleanupTables: ['things', 'users'],
});

let Thing: ThingModel;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  await dalFixture.initializeModels([{ key: 'things', alias: 'Thing' }]);
  Thing = dalFixture.getThingModel();
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
      source: 'wikidata',
    },
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;

  await thing.save();

  // Test that filterNotStaleOrDeleted works (used by sync scripts)
  const things = await Thing.filterWhere({}).run();
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
  t.is(
    foundThing.sync.description.source,
    'wikidata',
    'Description sync source should be wikidata'
  );
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
      source: 'wikidata',
    },
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;

  await thing.save();

  // Mock the Wikidata adapter to simulate sync
  type WikidataBackendAdapterCtor =
    typeof import('../adapters/wikidata-backend-adapter.ts').default;
  const WikidataBackendAdapter = (await import('../adapters/wikidata-backend-adapter.ts'))
    .default as WikidataBackendAdapterCtor;
  const originalLookup = WikidataBackendAdapter.prototype.lookup;

  WikidataBackendAdapter.prototype.lookup = async (url): Promise<AdapterLookupResult> => ({
    data: {
      label: { en: 'Synced label from Wikidata' },
      description: { en: 'Synced description from Wikidata' },
    },
    sourceID: 'wikidata',
  });

  try {
    // Test updateActiveSyncs (core sync functionality)
    const updatedThing = await thing.updateActiveSyncs(testUserId);

    // Verify description was synced to metadata
    t.truthy(updatedThing.metadata, 'Metadata should be created');
    t.truthy(updatedThing.metadata.description, 'Description should be in metadata');
    t.deepEqual(
      updatedThing.metadata.description,
      { en: 'Synced description from Wikidata' },
      'Description should be synced'
    );

    // Verify sync timestamp was updated
    t.truthy(updatedThing.sync.description.updated, 'Sync timestamp should be updated');
  } finally {
    // Restore original lookup method
    WikidataBackendAdapter.prototype.lookup = originalLookup;
  }
});

test.serial('adapter integration with PostgreSQL Thing model', async t => {
  // Test that adapters can work with the PostgreSQL Thing model
  type AdaptersModule = typeof import('../adapters/adapters.ts');
  const adapters = ((await import('../adapters/adapters.ts')) as AdaptersModule).default;

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
