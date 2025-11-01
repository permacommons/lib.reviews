import test, { registerCompletionHandler } from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.js';
import { ensureUserExists } from './helpers/dal-helpers-ava.js';
import { initializeDAL, isInitialized } from '../bootstrap/dal.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.js';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'search_integration',
  cleanupTables: ['users', 'things', 'reviews']
});

// Track indexing operations
let indexedItems = [];

test.before(async () => {
  await bootstrapPromise;

  const captured = mockSearch();
  indexedItems = captured.indexedItems;

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' }
  ]);

  dalFixture.Thing = models.Thing;
  dalFixture.Review = models.Review;
});

test.beforeEach(async t => {
  // Clear indexed items before each test
  indexedItems.length = 0;
});

test.after.always(async () => {
  unmockSearch();

  const { default: search } = await import('../search.js');
  if (search && typeof search.close === 'function') {
    await search.close();
  }
});

registerCompletionHandler(() => {
 const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exit(code);
});

// Ensure the AVA worker exits promptly after asynchronous teardown completes.

test.serial('maintenance script bootstraps PostgreSQL models', async t => {
  await initializeDAL();
  t.true(isInitialized(), 'DAL should report initialized state');

  const { default: ThingHandle } = await import('../models/thing.js');
  const { default: ReviewHandle } = await import('../models/review.js');
  t.truthy(ThingHandle.filterNotStaleOrDeleted, 'Thing handle exposes filterNotStaleOrDeleted');
  t.truthy(ReviewHandle.filterNotStaleOrDeleted, 'Review handle exposes filterNotStaleOrDeleted');
});

test.serial('search indexing integration with PostgreSQL models', async t => {
  
  const { Thing, Review } = dalFixture;
  const { default: search } = await import('../search.js');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Integration User');
  
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
  
  const { Thing, Review } = dalFixture;
  const { default: search } = await import('../search.js');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Bulk Index User');
  
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
  
  const { Thing } = dalFixture;
  const { default: search } = await import('../search.js');
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Revision Filter User');
  
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

test.after.always(async () => {
  await dalFixture.cleanup();
});
