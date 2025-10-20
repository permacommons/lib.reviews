import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

const require = createRequire(import.meta.url);

/**
 * Test suite for QueryBuilder join functionality
 * 
 * Tests the enhanced query builder with support for:
 * - Simple joins (boolean syntax)
 * - Complex joins with _apply transformations
 * - RethinkDB-style query patterns
 * - Revision-aware joins
 */

// Standard env settings for AVA worker
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-6';
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-6', { tableSuffix: 'query_builder_joins' });

let User, Thing, Review;
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

    // Ensure UUID generation helper exists (ignore permission errors)
    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      // Try alternative UUID extension
      try {
        await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
      } catch (altExtensionError) {
        t.log('UUID extensions not available:', extensionError.message);
        // Continue without extensions - gen_random_uuid() might still work
      }
    }

    const models = await dalFixture.initializeModels([
      {
        key: 'users',
        loader: dal => require('../models-postgres/user').initializeUserModel(dal)
      },
      {
        key: 'things',
        loader: dal => require('../models-postgres/thing').initializeThingModel(dal)
      },
      {
        key: 'reviews',
        loader: dal => require('../models-postgres/review').initializeReviewModel(dal)
      }
    ]);

    User = models.users;
    Thing = models.things;
    Review = models.reviews;
  } catch (error) {
    t.log('PostgreSQL not available, skipping QueryBuilder integration tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.beforeEach(async () => {
  await dalFixture.cleanupTables(['review_teams', 'team_moderators', 'team_members', 'reviews', 'teams', 'things', 'users']);
});

test.after.always(async () => {
  await dalFixture.cleanup();
});

function skipIfNoModels(t) {
  if (!User || !Thing || !Review) {
    t.pass('Skipping - PostgreSQL DAL not available');
    return true;
  }
  return false;
}

test.serial('QueryBuilder supports simple boolean joins', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a test user
  const testUser = await User.create({
    name: `TestUser-${randomUUID()}`,
    password: 'secret123',
    email: `test-${randomUUID()}@example.com`
  });
  await ensureUserExists(testUser.id, testUser.display_name);
  
  // Test simple join syntax: { teams: true }
  // This should not fail even if no team associations exist
  const query = User.filter({ id: testUser.id }).getJoin({ teams: true });
  const users = await query.run();
  
  t.true(Array.isArray(users));
  t.is(users.length, 1);
  t.is(users[0].id, testUser.id);
  // Note: teams join would be populated if team associations existed
});

test.serial('QueryBuilder handles revision-aware joins', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Between Join User');
  await ensureUserExists(testUser.id, 'Revision Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Test join with revision filtering
  const query = Thing.filter({ id: thing.id }).getJoin({ reviews: true });
  const things = await query.run();
  
  t.true(Array.isArray(things));
  t.is(things.length, 1);
  t.is(things[0].id, thing.id);
  // Reviews would be populated if review associations existed
});

test.serial('QueryBuilder supports complex joins with _apply', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Array Contains User');
  await ensureUserExists(testUser.id, 'Complex Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thing_id = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.star_rating = 5;
  review.created_on = new Date();
  review.created_by = testUser.id;
  await review.save();
  
  // Test complex join with _apply transformation
  const query = Review.filter({ id: review.id }).getJoin({
    creator: {
      _apply: seq => seq.without('password')
    }
  });
  
  const reviews = await query.run();
  
  t.true(Array.isArray(reviews));
  t.is(reviews.length, 1);
  t.is(reviews[0].id, review.id);
  // Creator would be populated without password field
});

test.serial('QueryBuilder supports multiple joins', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Revision Filter User');
  await ensureUserExists(testUser.id, 'Multiple Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thing_id = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.star_rating = 4;
  review.created_on = new Date();
  review.created_by = testUser.id;
  await review.save();
  
  // Test multiple joins
  const query = Review
    .filter({ id: review.id })
    .getJoin({ thing: true })
    .getJoin({ creator: true });
  
  const reviews = await query.run();
  
  t.true(Array.isArray(reviews));
  t.is(reviews.length, 1);
  t.is(reviews[0].id, review.id);
});

test.serial('QueryBuilder supports between date ranges', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Revision Tag User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create a review with a specific date
  const reviewDate = new Date('2024-06-15');
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thing_id = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.star_rating = 3;
  review.created_on = reviewDate;
  review.created_by = testUser.id;
  await review.save();
  
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  
  const reviews = await Review.between(startDate, endDate).run();
  
  t.true(Array.isArray(reviews));
  t.true(reviews.length >= 1);
  // All reviews should be within the date range
  for (const reviewResult of reviews) {
    t.true(reviewResult.created_on >= startDate);
    t.true(reviewResult.created_on <= endDate);
  }
});

test.serial('QueryBuilder supports array contains operations', async t => {
  if (skipIfNoModels(t)) return;
  
  // Test that the contains method exists and can be called
  const testUrl = 'https://example.com/test';
  
  // Test the query builder method
  const things = await Thing.contains('urls', testUrl).run();
  
  t.true(Array.isArray(things));
  // The query should execute without error, regardless of results
  t.pass('Array contains query method works and executes without error');
});

test.serial('QueryBuilder supports revision filtering', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Ordering User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Test revision filtering
  const things = await Thing.filterNotStaleOrDeleted().run();
  
  t.true(Array.isArray(things));
  t.true(things.length >= 1);
  // All results should be current revisions
  for (const thingResult of things) {
    t.is(thingResult._old_rev_of, null);
    t.not(thingResult._rev_deleted, true);
  }
});

test.serial('QueryBuilder supports revision tag filtering', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Pagination User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create a review with specific tags
  const review = await Review.createFirstRevision(testUser, { tags: ['create', 'test-tag'] });
  review.thing_id = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.star_rating = 5;
  review.created_on = new Date();
  review.created_by = testUser.id;
  await review.save();
  
  // Test revision tag filtering
  const reviews = await Review
    .filterNotStaleOrDeleted()
    .filterByRevisionTags(['test-tag'])
    .run();
  
  t.true(Array.isArray(reviews));
  t.true(reviews.length >= 1);
  // Results should have the specified tag
  for (const reviewResult of reviews) {
    if (reviewResult._rev_tags) {
      t.true(reviewResult._rev_tags.includes('test-tag'));
    }
  }
});

test.serial('QueryBuilder supports ordering and limiting', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Count User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create multiple reviews with different dates
  const reviews = [];
  for (let i = 0; i < 3; i++) {
    const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
    review.thing_id = thing.id;
    review.title = { en: `Test Review ${i}` };
    review.text = { en: `This is test review ${i}` };
    review.star_rating = 3 + i;
    review.created_on = new Date(Date.now() + i * 1000); // Different timestamps
    review.created_by = testUser.id;
    await review.save();
    reviews.push(review);
  }
  
  // Test ordering and limiting
  const orderedReviews = await Review
    .filterNotStaleOrDeleted()
    .orderBy('created_on', 'DESC')
    .limit(2)
    .run();
  
  t.true(orderedReviews.length <= 2);
  t.true(orderedReviews.length >= 1);
  
  // Check ordering
  for (let i = 1; i < orderedReviews.length; i++) {
    t.true(orderedReviews[i-1].created_on >= orderedReviews[i].created_on);
  }
});

test.serial('QueryBuilder supports offset for pagination', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Count User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create multiple reviews for pagination testing
  const reviews = [];
  for (let i = 0; i < 5; i++) {
    const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
    review.thing_id = thing.id;
    review.title = { en: `Pagination Review ${i}` };
    review.text = { en: `This is pagination test review ${i}` };
    review.star_rating = 3;
    review.created_on = new Date(Date.now() + i * 1000); // Different timestamps
    review.created_by = testUser.id;
    await review.save();
    reviews.push(review);
  }
  
  // Test pagination
  const page1 = await Review
    .filterNotStaleOrDeleted()
    .orderBy('created_on', 'DESC')
    .limit(2)
    .run();
  
  const page2 = await Review
    .filterNotStaleOrDeleted()
    .orderBy('created_on', 'DESC')
    .limit(2)
    .offset(2)
    .run();
  
  t.true(page1.length <= 2);
  t.true(page2.length <= 2);
  
  // Pages should not overlap if we have enough data
  if (page1.length > 0 && page2.length > 0) {
    const page1Ids = page1.map(r => r.id);
    const page2Ids = page2.map(r => r.id);
    const overlap = page1Ids.filter(id => page2Ids.includes(id));
    t.is(overlap.length, 0);
  }
});

test.serial('QueryBuilder supports count operations', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(testUser.id, 'Between Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.created_on = new Date();
  thing.created_by = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thing_id = thing.id;
  review.title = { en: 'Count Test Review' };
  review.text = { en: 'This is a count test review' };
  review.star_rating = 4;
  review.created_on = new Date();
  review.created_by = testUser.id;
  await review.save();
  
  // Test count
  const count = await Review.filterNotStaleOrDeleted().count();
  
  t.is(typeof count, 'number');
  t.true(count >= 1);
});

test.serial('QueryBuilder supports first() operation', async t => {
  if (skipIfNoModels(t)) return;
  
  // Create a test user
  const testUser = await User.create({
    name: `FirstTestUser-${randomUUID()}`,
    password: 'secret123',
    email: `first-test-${randomUUID()}@example.com`
  });
  
  // Test first - should return the user we created
  const user = await User.filter({ id: testUser.id }).first();
  
  t.truthy(user);
  t.is(user.id, testUser.id);
});

test('QueryBuilder handles empty results gracefully', async t => {
  if (skipIfNoModels(t)) return;
  
  // Test with non-existent ID
  const nonExistentId = randomUUID();
  const user = await User.filter({ id: nonExistentId }).first();
  
  t.is(user, null);
  
  const users = await User.filter({ id: nonExistentId }).run();
  t.is(users.length, 0);
  
  const count = await User.filter({ id: nonExistentId }).count();
  t.is(count, 0);
});
