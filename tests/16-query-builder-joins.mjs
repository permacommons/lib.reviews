import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

import { ensureUserExists } from './helpers/dal-helpers-ava.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';

/**
 * Test suite for QueryBuilder join functionality
 * 
 * Tests the enhanced query builder with support for:
 * - Simple joins (boolean syntax)
 * - Complex joins with _apply transformations
 * - Query patterns
 * - Revision-aware joins
 */

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'query_builder_joins',
  cleanupTables: [
    'review_teams',
    'team_moderators',
    'team_members',
    'reviews',
    'teams',
    'things',
    'users'
  ]
});

let User, Thing, Review, Team;

test.before(async () => {
  await bootstrapPromise;

  // Stub search module to avoid starting Elasticsearch clients during tests
  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
    { key: 'teams', alias: 'Team' }
  ]);

  User = models.User;
  Thing = models.Thing;
  Review = models.Review;
  Team = models.Team;
});

test.serial('QueryBuilder supports simple boolean joins', async t => {

  // Create a test user
  const { actor: testUserActor } = await dalFixture.createTestUser('Test User');
  const testUser = await User.get(testUserActor.id);
  await ensureUserExists(dalFixture, testUser.id, testUser.displayName);
  
  // Test simple join syntax: { teams: true }
  // This should not fail even if no team associations exist
  const query = User.filter({ id: testUser.id }).getJoin({ teams: true });
  const users = await query.run();
  
  t.true(Array.isArray(users));
  t.is(users.length, 1);
  t.is(users[0].id, testUser.id);
  // Note: teams join would be populated if team associations existed
});

test.serial('QueryBuilder builds join SQL using model metadata', async t => {

  const userQuery = User.getJoin({ teams: true });
  const { sql: userSql } = userQuery._buildSelectQuery();

  const usersTable = dalFixture.getTableName('users');
  const teamMembersTable = dalFixture.getTableName('team_members');
  const teamsTable = dalFixture.getTableName('teams');

  t.true(
    userSql.includes(`LEFT JOIN ${teamMembersTable} ON ${usersTable}.id = ${teamMembersTable}.user_id`),
    'User join should include metadata-defined join table'
  );
  t.true(
    userSql.includes(`LEFT JOIN ${teamsTable} ON ${teamMembersTable}.team_id = ${teamsTable}.id AND ${teamsTable}._old_rev_of IS NULL AND (${teamsTable}._rev_deleted IS NULL OR ${teamsTable}._rev_deleted = false)`),
    'User join should include revision-aware join condition from metadata'
  );

  const reviewQuery = Review.getJoin({ thing: true, creator: true });
  const { sql: reviewSql } = reviewQuery._buildSelectQuery();
  const reviewsTable = dalFixture.getTableName('reviews');
  const thingsTable = dalFixture.getTableName('things');

  t.true(
    reviewSql.includes(`LEFT JOIN ${thingsTable} ON ${reviewsTable}.thing_id = ${thingsTable}.id AND ${thingsTable}._old_rev_of IS NULL AND (${thingsTable}._rev_deleted IS NULL OR ${thingsTable}._rev_deleted = false)`),
    'Review join should include revision-aware target join'
  );
  t.true(
    reviewSql.includes(`LEFT JOIN ${usersTable} ON ${reviewsTable}.created_by = ${usersTable}.id`),
    'Review join should include creator join from metadata'
  );
});

test.serial('QueryBuilder handles revision-aware joins', async t => {
  
  // Create a test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Between Join User');
  await ensureUserExists(dalFixture, testUser.id, 'Revision Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
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

  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Array Contains User');
  await ensureUserExists(dalFixture, testUser.id, 'Complex Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = testUser.id;
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
  t.truthy(reviews[0].creator);
  t.true(reviews[0].creator instanceof User);
  t.is(reviews[0].creator.id, testUser.id);
  t.is(reviews[0].creator.password, undefined);
});

test.serial('QueryBuilder materializes hasMany relations using model metadata', async t => {

  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'HasMany Join User');

  const thingDraft = await Thing.createFirstRevision(testUser, { tags: ['join'] });
  thingDraft.urls = [`https://example.com/${randomUUID()}`];
  thingDraft.label = { en: 'Join Test Thing' };
  thingDraft.createdOn = new Date();
  thingDraft.createdBy = testUser.id;
  await thingDraft.save();

  const reviewDraft = await Review.createFirstRevision(testUser, { tags: ['join'] });
  reviewDraft.thingID = thingDraft.id;
  reviewDraft.title = { en: 'Join Review' };
  reviewDraft.text = { en: 'Join review text' };
  reviewDraft.starRating = 4;
  reviewDraft.createdOn = new Date();
  reviewDraft.createdBy = testUser.id;
  await reviewDraft.save();

  const things = await Thing.filter({ id: thingDraft.id }).getJoin({ reviews: {} }).run();

  t.is(things.length, 1);
  const loadedThing = things[0];
  t.true(Array.isArray(loadedThing.reviews));
  t.is(loadedThing.reviews.length, 1);
  t.true(loadedThing.reviews[0] instanceof Review);
  t.is(loadedThing.reviews[0].thingID, thingDraft.id);
});

test.serial('QueryBuilder materializes through-table joins generically', async t => {

  const userId = randomUUID();
  await ensureUserExists(dalFixture, userId, 'Through Join User');

  const teamDraft = await Team.createFirstRevision({ id: userId, is_super_user: false, is_trusted: true }, { tags: ['create'] });
  teamDraft.name = { en: 'Join Test Team' };
  teamDraft.motto = { en: 'Together' };
  teamDraft.description = { text: { en: 'Team description' }, html: { en: '<p>Team description</p>' } };
  teamDraft.rules = { text: { en: 'Be kind' }, html: { en: '<p>Be kind</p>' } };
  teamDraft.createdBy = userId;
  teamDraft.createdOn = new Date();
  teamDraft.originalLanguage = 'en';
  teamDraft.confersPermissions = {};
  await teamDraft.save();

  const teamMembersTable = dalFixture.getTableName('team_members');
  await dalFixture.query(
    `INSERT INTO ${teamMembersTable} (team_id, user_id) VALUES ($1, $2)`,
    [teamDraft.id, userId]
  );

  const users = await User.filter({ id: userId }).getJoin({ teams: {} }).run();

  t.is(users.length, 1);
  const loadedUser = users[0];
  t.true(Array.isArray(loadedUser.teams));
  t.is(loadedUser.teams.length, 1);
  t.true(loadedUser.teams[0] instanceof Team);
  t.is(loadedUser.teams[0].id, teamDraft.id);
});

test.serial('QueryBuilder supports multiple joins', async t => {
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Revision Filter User');
  await ensureUserExists(dalFixture, testUser.id, 'Multiple Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.starRating = 4;
  review.createdOn = new Date();
  review.createdBy = testUser.id;
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
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Revision Tag User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create a review with a specific date
  const reviewDate = new Date('2024-06-15');
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.starRating = 3;
  review.createdOn = reviewDate;
  review.createdBy = testUser.id;
  await review.save();
  
  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');
  
  const reviews = await Review.between(startDate, endDate).run();
  
  t.true(Array.isArray(reviews));
  t.true(reviews.length >= 1);
  // All reviews should be within the date range
  for (const reviewResult of reviews) {
    t.true(reviewResult.createdOn >= startDate);
    t.true(reviewResult.createdOn <= endDate);
  }
});

test.serial('QueryBuilder supports array contains operations', async t => {
  
  // Test that the contains method exists and can be called
  const testUrl = 'https://example.com/test';
  
  // Test the query builder method
  const things = await Thing.contains('urls', testUrl).run();
  
  t.true(Array.isArray(things));
  // The query should execute without error, regardless of results
  t.pass('Array contains query method works and executes without error');
});

test.serial('QueryBuilder supports revision filtering', async t => {
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Ordering User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
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
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Pagination User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create a review with specific tags
  const review = await Review.createFirstRevision(testUser, { tags: ['create', 'test-tag'] });
  review.thingID = thing.id;
  review.title = { en: 'Test Review' };
  review.text = { en: 'This is a test review' };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = testUser.id;
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
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Count User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create multiple reviews with different dates
  const reviews = [];
  for (let i = 0; i < 3; i++) {
    const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
    review.thingID = thing.id;
    review.title = { en: `Test Review ${i}` };
    review.text = { en: `This is test review ${i}` };
    review.starRating = 3 + i;
    review.createdOn = new Date(Date.now() + i * 1000); // Different timestamps
    review.createdBy = testUser.id;
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
    t.true(orderedReviews[i-1].createdOn >= orderedReviews[i].createdOn);
  }
});

test.serial('QueryBuilder supports offset for pagination', async t => {
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Count User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create multiple reviews for pagination testing
  const reviews = [];
  for (let i = 0; i < 5; i++) {
    const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
    review.thingID = thing.id;
    review.title = { en: `Pagination Review ${i}` };
    review.text = { en: `This is pagination test review ${i}` };
    review.starRating = 3;
    review.createdOn = new Date(Date.now() + i * 1000); // Different timestamps
    review.createdBy = testUser.id;
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
  
  // Create test user and thing
  const testUser = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUser.id, 'Between Join User');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();
  
  // Create a review
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Count Test Review' };
  review.text = { en: 'This is a count test review' };
  review.starRating = 4;
  review.createdOn = new Date();
  review.createdBy = testUser.id;
  await review.save();
  
  // Test count
  const count = await Review.filterNotStaleOrDeleted().count();
  
  t.is(typeof count, 'number');
  t.true(count >= 1);
});

test.serial('QueryBuilder supports first() operation', async t => {

  // Create a test user
  const { actor: testUser } = await dalFixture.createTestUser('First Test User');

  // Test first - should return the user we created
  const user = await User.filter({ id: testUser.id }).first();

  t.truthy(user);
  t.is(user.id, testUser.id);
});

test('QueryBuilder handles empty results gracefully', async t => {
  
  // Test with non-existent ID
  const nonExistentId = randomUUID();
  const user = await User.filter({ id: nonExistentId }).first();
  
  t.is(user, null);
  
  const users = await User.filter({ id: nonExistentId }).run();
  t.is(users.length, 0);
  
  const count = await User.filter({ id: nonExistentId }).count();
  t.is(count, 0);
});

test.after.always(async () => {
  unmockSearch();
  await dalFixture.cleanup();
});
