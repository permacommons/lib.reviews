import test, { registerCompletionHandler } from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Standard env settings
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-2'; // Use testing-2 for search tests

if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

// Test setup
const { createDALFixtureAVA } = await import('./fixtures/dal-fixture-ava.mjs');
const dalFixture = createDALFixtureAVA('testing-2', { tableSuffix: 'search_integration' });

// Track indexing operations
let indexedItems = [];
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
  // Mock search module to capture indexing operations
  const searchPath = require.resolve('../search');
  require.cache[searchPath] = {
    exports: {
      indexThing(thing) {
        // Apply the same revision filtering as the real function
        if (thing._old_rev_of || thing._rev_deleted) {
          return Promise.resolve();
        }
        indexedItems.push({ type: 'thing', data: thing });
        return Promise.resolve();
      },
      indexReview(review) {
        // Apply the same revision filtering as the real function
        if (review._old_rev_of || review._rev_deleted) {
          return Promise.resolve();
        }
        indexedItems.push({ type: 'review', data: review });
        return Promise.resolve();
      },
      createIndices: () => Promise.resolve(),
      searchThings: async () => ({ hits: { hits: [], total: { value: 0 } } }),
      searchReviews: async () => ({ hits: { hits: [], total: { value: 0 } } }),
      getClient: () => ({})
    }
  };
  
  try {
    await dalFixture.bootstrap();

    // Ensure UUID generation helper exists
    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      t.log('pgcrypto extension not available:', extensionError.message);
    }

    const models = await dalFixture.initializeModels([
      {
        key: 'things',
        loader: dal => require('../models-postgres/thing').initializeThingModel(dal)
      },
      {
        key: 'reviews',
        loader: dal => require('../models-postgres/review').initializeReviewModel(dal)
      }
    ]);

    dalFixture.Thing = models.things;
    dalFixture.Review = models.reviews;
    
  } catch (error) {
    t.log('PostgreSQL not available, skipping search integration tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.beforeEach(async t => {
  // Clean up tables between tests
  await dalFixture.cleanupTables(['users', 'things', 'reviews']);
  
  // Clear indexed items before each test
  indexedItems.length = 0;
});

test.after.always(async () => {
  const searchPath = require.resolve('../search');
  delete require.cache[searchPath];
  await dalFixture.cleanup();
});

// Ensure the AVA worker exits promptly after asynchronous teardown completes.
registerCompletionHandler(() => {
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exit(code);
});

function skipIfNoModels(t) {
  if (!dalFixture.Thing || !dalFixture.Review) {
    t.pass('Skipping - PostgreSQL models not available');
    return true;
  }
  return false;
}

test.serial('maintenance script model selection works with PostgreSQL', async t => {
  if (skipIfNoModels(t)) return;
  
  // Test the logic from maintenance/index-all.js
  const { isDualDatabaseMode, getPostgresDAL } = require('../db-dual');
  
  let Thing, Review;
  
  // Simulate the model selection logic from the maintenance script
  if (isDualDatabaseMode() && getPostgresDAL()) {
    // Should use PostgreSQL models
    const { getPostgresThingModel } = require('../models-postgres/thing');
    const { getPostgresReviewModel } = require('../models-postgres/review');
    Thing = getPostgresThingModel();
    Review = getPostgresReviewModel();
  } else {
    // Would use RethinkDB models
    Thing = require('../models/thing');
    Review = require('../models/review');
  }
  
  t.truthy(Thing, 'Thing model should be available');
  t.truthy(Review, 'Review model should be available');
  
  if (Thing && Review) {
    t.truthy(Thing.filterNotStaleOrDeleted, 'Thing model should have filterNotStaleOrDeleted method');
    t.truthy(Review.filterNotStaleOrDeleted, 'Review model should have filterNotStaleOrDeleted method');
  }
});

test.serial('search indexing integration with PostgreSQL models', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing, Review } = dalFixture;
  const search = require('../search');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(testUserId, 'Integration User');
  
  // Create test data
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/integration-test'];
  thing.label = { en: 'Integration Test Item', de: 'Integrations-Testelement' };
  thing.aliases = { en: ['Integration Alias'], de: ['Integrations-Alias'] };
  thing.metadata = {
    description: { 
      en: 'Integration test description',
      de: 'Integrations-Testbeschreibung'
    },
    subtitle: { 
      en: 'Integration Edition',
      de: 'Integrations-Ausgabe'
    },
    authors: [
      { en: 'Integration Author', de: 'Integrations-Autor' }
    ]
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
  await thing.save();
  
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Integration Test Review', de: 'Integrations-Test-Bewertung' };
  review.text = { en: 'Integration test review text', de: 'Integrations-Test-Bewertungstext' };
  review.html = { en: '<p>Integration test review text</p>', de: '<p>Integrations-Test-Bewertungstext</p>' };
  review.starRating = 4;
  review.createdOn = new Date();
  review.createdBy = testUserId;
  
  await review.save();
  
  // Test indexing
  await search.indexThing(thing);
  await search.indexReview(review);
  
  // Verify indexing
  t.is(indexedItems.length, 2, 'Should have indexed 2 items');
  
  const indexedThing = indexedItems.find(item => item.type === 'thing');
  const indexedReview = indexedItems.find(item => item.type === 'review');
  
  t.truthy(indexedThing, 'Should have indexed the thing');
  t.truthy(indexedReview, 'Should have indexed the review');
  
  // Verify thing indexing
  t.is(indexedThing.data.id, thing.id, 'Indexed thing should have correct ID');
  t.deepEqual(indexedThing.data.label, thing.label, 'Indexed thing should have correct label');
  t.deepEqual(indexedThing.data.metadata.description, thing.metadata.description, 'Indexed thing should have correct description');
  
  // Verify review indexing
  t.is(indexedReview.data.id, review.id, 'Indexed review should have correct ID');
  t.is(indexedReview.data.thingID, thing.id, 'Indexed review should have correct thing_id');
  t.deepEqual(indexedReview.data.title, review.title, 'Indexed review should have correct title');
});

test.serial('bulk indexing simulation with filterNotStaleOrDeleted', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing, Review } = dalFixture;
  const search = require('../search');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(testUserId, 'Bulk Index User');
  
  // Create multiple things and reviews
  const things = [];
  const reviews = [];
  
  for (let i = 0; i < 5; i++) {
    const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
    thing.urls = [`https://example.com/bulk-test-${i}`];
    thing.label = { en: `Bulk Test Item ${i}` };
    thing.metadata = {
      description: { en: `Bulk test description ${i}` }
    };
    thing.createdOn = new Date();
    thing.createdBy = testUserId;
    
    await thing.save();
    things.push(thing);
    
    const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
    review.thingID = thing.id;
    review.title = { en: `Bulk Test Review ${i}` };
    review.text = { en: `Bulk test review text ${i}` };
    review.html = { en: `<p>Bulk test review text ${i}</p>` };
    review.starRating = (i % 5) + 1;
    review.createdOn = new Date();
    review.createdBy = testUserId;
    
    await review.save();
    reviews.push(review);
  }
  
  // Simulate the maintenance script logic
  const currentThings = await Thing.filterNotStaleOrDeleted().run();
  const currentReviews = await Review.filterNotStaleOrDeleted().run();
  
  t.true(currentThings.length >= 5, `Should have at least 5 current things (found ${currentThings.length})`);
  t.true(currentReviews.length >= 5, `Should have at least 5 current reviews (found ${currentReviews.length})`);
  
  // Index all current items
  for (const thing of currentThings) {
    await search.indexThing(thing);
  }
  
  for (const review of currentReviews) {
    await search.indexReview(review);
  }
  
  // Verify all items were indexed
  const indexedThings = indexedItems.filter(item => item.type === 'thing');
  const indexedReviews = indexedItems.filter(item => item.type === 'review');
  
  t.true(indexedThings.length >= 5, `Should have indexed at least 5 things (indexed ${indexedThings.length})`);
  t.true(indexedReviews.length >= 5, `Should have indexed at least 5 reviews (indexed ${indexedReviews.length})`);
  
  // Verify data integrity
  for (const indexedThing of indexedThings) {
    t.truthy(indexedThing.data.id, 'Indexed thing should have ID');
    t.truthy(indexedThing.data.label, 'Indexed thing should have label');
    t.falsy(indexedThing.data._old_rev_of, 'Indexed thing should not be old revision');
    t.falsy(indexedThing.data._rev_deleted, 'Indexed thing should not be deleted');
  }
  
  for (const indexedReview of indexedReviews) {
    t.truthy(indexedReview.data.id, 'Indexed review should have ID');
    t.truthy(indexedReview.data.thingID, 'Indexed review should have thing_id');
    t.truthy(indexedReview.data.title, 'Indexed review should have title');
    t.falsy(indexedReview.data._old_rev_of, 'Indexed review should not be old revision');
    t.falsy(indexedReview.data._rev_deleted, 'Indexed review should not be deleted');
  }
});

test.serial('search indexing skips old and deleted revisions in bulk operations', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing } = dalFixture;
  const search = require('../search');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(testUserId, 'Revision Filter User');
  
  // Create a thing and then create a new revision (making the first one old)
  const originalThing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  originalThing.urls = ['https://example.com/revision-test'];
  originalThing.label = { en: 'Original Version' };
  originalThing.createdOn = new Date();
  originalThing.createdBy = testUserId;
  
  await originalThing.save();
  
  // Create a new revision
  const updatedThing = await originalThing.newRevision(testUser, { tags: ['update'] });
  updatedThing.label = { en: 'Updated Version' };
  
  await updatedThing.save();
  
  // Now query for current revisions only
  const currentThings = await Thing.filterNotStaleOrDeleted().run();
  
  // Should only get the current revision
  const matchingThings = currentThings.filter(t => 
    t.urls && t.urls.includes('https://example.com/revision-test')
  );
  
  t.is(matchingThings.length, 1, 'Should only find one current revision');
  t.is(matchingThings[0].label.en, 'Updated Version', 'Should find the updated version');
  
  // Index all current things
  for (const thing of currentThings) {
    await search.indexThing(thing);
  }
  
  // Verify only current revisions were indexed
  const indexedThings = indexedItems.filter(item => 
    item.type === 'thing' && 
    item.data.urls && 
    item.data.urls.includes('https://example.com/revision-test')
  );
  
  t.is(indexedThings.length, 1, 'Should only index one revision');
  t.is(indexedThings[0].data.label.en, 'Updated Version', 'Should index the updated version');
});
