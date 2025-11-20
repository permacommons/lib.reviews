import test from 'ava';
import { randomUUID } from 'crypto';
import { ensureUserExists } from './helpers/dal-helpers-ava.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

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
    'users',
  ],
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
    { key: 'teams', alias: 'Team' },
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
  const query = User.filterWhere({ id: testUser.id }).getJoin({ teams: true });
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
    userSql.includes(
      `LEFT JOIN ${teamMembersTable} ON ${usersTable}.id = ${teamMembersTable}.user_id`
    ),
    'User join should include metadata-defined join table'
  );
  t.true(
    userSql.includes(
      `LEFT JOIN ${teamsTable} ON ${teamMembersTable}.team_id = ${teamsTable}.id AND ${teamsTable}._old_rev_of IS NULL AND (${teamsTable}._rev_deleted IS NULL OR ${teamsTable}._rev_deleted = false)`
    ),
    'User join should include revision-aware join condition from metadata'
  );

  const reviewQuery = Review.getJoin({ thing: true, creator: true });
  const { sql: reviewSql } = reviewQuery._buildSelectQuery();
  const reviewsTable = dalFixture.getTableName('reviews');
  const thingsTable = dalFixture.getTableName('things');

  t.true(
    reviewSql.includes(
      `LEFT JOIN ${thingsTable} ON ${reviewsTable}.thing_id = ${thingsTable}.id AND ${thingsTable}._old_rev_of IS NULL AND (${thingsTable}._rev_deleted IS NULL OR ${thingsTable}._rev_deleted = false)`
    ),
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
  const { containsAll, neq } = Thing.ops;
  const query = Thing.filterWhere({ id: thing.id })
    .and({ id: neq(randomUUID()), urls: containsAll(thing.urls) })
    .getJoin({ reviews: true });
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
  const query = Review.filterWhere({ id: review.id }).getJoin({
    creator: {
      _apply: seq => seq.without('password'),
    },
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

  const { containsAll: includesUrl } = Thing.ops;
  const things = await Thing.filterWhere({ id: thingDraft.id })
    .and({ urls: includesUrl(thingDraft.urls) })
    .getJoin({ reviews: {} })
    .run();

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

  const teamDraft = await Team.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['create'] }
  );
  teamDraft.name = { en: 'Join Test Team' };
  teamDraft.motto = { en: 'Together' };
  teamDraft.description = {
    text: { en: 'Team description' },
    html: { en: '<p>Team description</p>' },
  };
  teamDraft.rules = { text: { en: 'Be kind' }, html: { en: '<p>Be kind</p>' } };
  teamDraft.createdBy = userId;
  teamDraft.createdOn = new Date();
  teamDraft.originalLanguage = 'en';
  teamDraft.confersPermissions = {};
  await teamDraft.save();

  const teamMembersTable = dalFixture.getTableName('team_members');
  await dalFixture.query(`INSERT INTO ${teamMembersTable} (team_id, user_id) VALUES ($1, $2)`, [
    teamDraft.id,
    userId,
  ]);

  const users = await User.filterWhere({ id: userId }).getJoin({ teams: {} }).run();

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
  const query = Review.filterWhere({ id: review.id })
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

  const { containsAll } = Thing.ops;
  const things = await Thing.filterWhere({ urls: containsAll(testUrl) }).run();

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
  const things = await Thing.filterWhere({}).run();

  t.true(Array.isArray(things));
  t.true(things.length >= 1);
  // All results should be current revisions
  for (const thingResult of things) {
    t.is(thingResult._oldRevOf, null);
    t.not(thingResult._revDeleted, true);
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

  const { containsAny } = Review.ops;
  const reviews = await Review.filterWhere({})
    .revisionData({ _revTags: containsAny(['test-tag']) })
    .run();

  t.true(Array.isArray(reviews));
  t.true(reviews.length >= 1);
  // Results should have the specified tag
  for (const reviewResult of reviews) {
    if (reviewResult._revTags) {
      t.true(reviewResult._revTags.includes('test-tag'));
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
  const orderedReviews = await Review.filterWhere({}).orderBy('createdOn', 'DESC').limit(2).run();

  t.true(orderedReviews.length <= 2);
  t.true(orderedReviews.length >= 1);

  // Check ordering
  for (let i = 1; i < orderedReviews.length; i++) {
    t.true(orderedReviews[i - 1].createdOn >= orderedReviews[i].createdOn);
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
  const page1 = await Review.filterWhere({}).orderBy('createdOn', 'DESC').limit(2).run();

  const page2 = await Review.filterWhere({}).orderBy('createdOn', 'DESC').limit(2).offset(2).run();

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
  const count = await Review.filterWhere({}).count();

  t.is(typeof count, 'number');
  t.true(count >= 1);
});

test.serial('QueryBuilder supports first() operation', async t => {
  // Create a test user
  const { actor: testUser } = await dalFixture.createTestUser('First Test User');

  // Test first - should return the user we created
  const user = await User.filterWhere({ id: testUser.id }).first();

  t.truthy(user);
  t.is(user.id, testUser.id);
});

test('QueryBuilder handles empty results gracefully', async t => {
  // Test with non-existent ID
  const nonExistentId = randomUUID();
  const user = await User.filterWhere({ id: nonExistentId }).first();

  t.is(user, null);

  const users = await User.filterWhere({ id: nonExistentId }).run();
  t.is(users.length, 0);

  const count = await User.filterWhere({ id: nonExistentId }).count();
  t.is(count, 0);
});

test.serial('Model.loadManyRelated batch-loads through junction tables', async t => {
  // Create test users
  const user1 = { id: randomUUID(), is_super_user: false, is_trusted: true };
  const user2 = { id: randomUUID(), is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, user1.id, 'Batch Load User 1');
  await ensureUserExists(dalFixture, user2.id, 'Batch Load User 2');

  // Create test teams
  const team1Draft = await Team.createFirstRevision(user1, { tags: ['batch-test'] });
  team1Draft.name = { en: 'Team Alpha' };
  team1Draft.motto = { en: 'First' };
  team1Draft.description = { text: { en: 'Team 1' }, html: { en: '<p>Team 1</p>' } };
  team1Draft.rules = { text: { en: 'Rule 1' }, html: { en: '<p>Rule 1</p>' } };
  team1Draft.createdBy = user1.id;
  team1Draft.createdOn = new Date();
  team1Draft.originalLanguage = 'en';
  team1Draft.confersPermissions = {};
  await team1Draft.save();

  const team2Draft = await Team.createFirstRevision(user1, { tags: ['batch-test'] });
  team2Draft.name = { en: 'Team Beta' };
  team2Draft.motto = { en: 'Second' };
  team2Draft.description = { text: { en: 'Team 2' }, html: { en: '<p>Team 2</p>' } };
  team2Draft.rules = { text: { en: 'Rule 2' }, html: { en: '<p>Rule 2</p>' } };
  team2Draft.createdBy = user1.id;
  team2Draft.createdOn = new Date();
  team2Draft.originalLanguage = 'en';
  team2Draft.confersPermissions = {};
  await team2Draft.save();

  // Create test things and reviews
  const thing1 = await Thing.createFirstRevision(user1, { tags: ['batch-test'] });
  thing1.urls = [`https://example.com/${randomUUID()}`];
  thing1.label = { en: 'Batch Test Thing 1' };
  thing1.createdOn = new Date();
  thing1.createdBy = user1.id;
  await thing1.save();

  const thing2 = await Thing.createFirstRevision(user2, { tags: ['batch-test'] });
  thing2.urls = [`https://example.com/${randomUUID()}`];
  thing2.label = { en: 'Batch Test Thing 2' };
  thing2.createdOn = new Date();
  thing2.createdBy = user2.id;
  await thing2.save();

  const review1 = await Review.createFirstRevision(user1, { tags: ['batch-test'] });
  review1.thingID = thing1.id;
  review1.title = { en: 'Review 1' };
  review1.text = { en: 'Review 1 text' };
  review1.starRating = 5;
  review1.createdOn = new Date();
  review1.createdBy = user1.id;
  await review1.save();

  const review2 = await Review.createFirstRevision(user2, { tags: ['batch-test'] });
  review2.thingID = thing2.id;
  review2.title = { en: 'Review 2' };
  review2.text = { en: 'Review 2 text' };
  review2.starRating = 4;
  review2.createdOn = new Date();
  review2.createdBy = user2.id;
  await review2.save();

  // Associate reviews with teams
  const reviewTeamsTable = dalFixture.getTableName('review_teams');
  await dalFixture.query(`INSERT INTO ${reviewTeamsTable} (review_id, team_id) VALUES ($1, $2)`, [
    review1.id,
    team1Draft.id,
  ]);
  await dalFixture.query(`INSERT INTO ${reviewTeamsTable} (review_id, team_id) VALUES ($1, $2)`, [
    review1.id,
    team2Draft.id,
  ]);
  await dalFixture.query(`INSERT INTO ${reviewTeamsTable} (review_id, team_id) VALUES ($1, $2)`, [
    review2.id,
    team2Draft.id,
  ]);

  // Test batch loading teams for multiple reviews
  const reviewTeamMap = await Review.loadManyRelated('teams', [review1.id, review2.id]);

  // Verify structure
  t.true(reviewTeamMap instanceof Map);
  t.is(reviewTeamMap.size, 2);

  // Verify review1 has 2 teams
  const review1Teams = reviewTeamMap.get(review1.id);
  t.truthy(review1Teams);
  t.is(review1Teams.length, 2);
  t.true(review1Teams[0] instanceof Team);
  t.true(review1Teams[1] instanceof Team);
  const review1TeamIds = review1Teams.map(team => team.id).sort();
  t.deepEqual(review1TeamIds, [team1Draft.id, team2Draft.id].sort());

  // Verify review2 has 1 team
  const review2Teams = reviewTeamMap.get(review2.id);
  t.truthy(review2Teams);
  t.is(review2Teams.length, 1);
  t.true(review2Teams[0] instanceof Team);
  t.is(review2Teams[0].id, team2Draft.id);
});

test.serial('Model.loadManyRelated returns empty map for no results', async t => {
  const nonExistentId = randomUUID();
  const reviewTeamMap = await Review.loadManyRelated('teams', [nonExistentId]);

  t.true(reviewTeamMap instanceof Map);
  t.is(reviewTeamMap.size, 0);
});

test.serial('Model.loadManyRelated handles empty input array', async t => {
  const reviewTeamMap = await Review.loadManyRelated('teams', []);

  t.true(reviewTeamMap instanceof Map);
  t.is(reviewTeamMap.size, 0);
});

test.serial('Model.loadManyRelated throws helpful error for unknown relation', async t => {
  const error = await t.throwsAsync(
    async () => await Review.loadManyRelated('nonExistentRelation', ['some-id']),
    { instanceOf: Error }
  );

  t.truthy(error);
  t.true(error.message.includes("Relation 'nonExistentRelation' not found"));
  t.true(error.message.includes('Available relations:'));
  t.true(error.message.includes('teams'));
  t.true(error.message.includes('reviews'));
});

test.serial('Model.loadManyRelated respects revision system guards', async t => {
  const userId = randomUUID();
  await ensureUserExists(dalFixture, userId, 'Revision Guard User');

  // Create a team
  const teamDraft = await Team.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['revision-test'] }
  );
  teamDraft.name = { en: 'Revision Test Team' };
  teamDraft.motto = { en: 'Test' };
  teamDraft.description = { text: { en: 'Test' }, html: { en: '<p>Test</p>' } };
  teamDraft.rules = { text: { en: 'Test' }, html: { en: '<p>Test</p>' } };
  teamDraft.createdBy = userId;
  teamDraft.createdOn = new Date();
  teamDraft.originalLanguage = 'en';
  teamDraft.confersPermissions = {};
  await teamDraft.save();

  // Create a thing and review
  const thing = await Thing.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['revision-test'] }
  );
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Revision Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = userId;
  await thing.save();

  const review = await Review.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['revision-test'] }
  );
  review.thingID = thing.id;
  review.title = { en: 'Revision Test Review' };
  review.text = { en: 'Test' };
  review.starRating = 3;
  review.createdOn = new Date();
  review.createdBy = userId;
  await review.save();

  // Associate review with team
  const reviewTeamsTable = dalFixture.getTableName('review_teams');
  await dalFixture.query(`INSERT INTO ${reviewTeamsTable} (review_id, team_id) VALUES ($1, $2)`, [
    review.id,
    teamDraft.id,
  ]);

  // Verify team is loaded
  let reviewTeamMap = await Review.loadManyRelated('teams', [review.id]);
  t.is(reviewTeamMap.get(review.id)?.length, 1);

  // Mark team as deleted
  const teamsTable = dalFixture.getTableName('teams');
  await dalFixture.query(`UPDATE ${teamsTable} SET _rev_deleted = true WHERE id = $1`, [
    teamDraft.id,
  ]);

  // Verify deleted team is excluded
  reviewTeamMap = await Review.loadManyRelated('teams', [review.id]);
  t.is(reviewTeamMap.get(review.id)?.length ?? 0, 0);
});

test.serial('Model.addManyRelated creates junction table associations', async t => {
  // Create a thing and review
  const userId = randomUUID();
  await ensureUserExists(dalFixture, userId);

  const thing = await Thing.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['addmanyrelated-test'] }
  );
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = userId;
  await thing.save();

  const review = await Review.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['addmanyrelated-test'] }
  );
  review.thingID = thing.id;
  review.title = { en: 'Test Review for addManyRelated' };
  review.text = { en: 'Test content' };
  review.starRating = 4;
  review.createdOn = new Date();
  review.createdBy = userId;
  await review.save();

  // Create two teams
  const team1 = await Team.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['addmanyrelated-test'] }
  );
  team1.name = { en: 'Team One' };
  team1.teamType = 'trusted users';
  team1.createdOn = new Date();
  team1.createdBy = userId;
  await team1.save();

  const team2 = await Team.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['addmanyrelated-test'] }
  );
  team2.name = { en: 'Team Two' };
  team2.teamType = 'moderators';
  team2.createdOn = new Date();
  team2.createdBy = userId;
  await team2.save();

  // Associate review with both teams using addManyRelated
  await Review.addManyRelated('teams', review.id!, [team1.id!, team2.id!]);

  // Verify associations were created
  const reviewTeamMap = await Review.loadManyRelated('teams', [review.id!]);
  t.is(reviewTeamMap.get(review.id!)?.length, 2);

  const teamIds = reviewTeamMap
    .get(review.id!)
    ?.map(t => t.id)
    .sort();
  t.deepEqual(teamIds, [team1.id, team2.id].sort());
});

test.serial('Model.addManyRelated handles duplicates with ON CONFLICT DO NOTHING', async t => {
  // Create a thing and review
  const userId = randomUUID();
  await ensureUserExists(dalFixture, userId);

  const thing = await Thing.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['duplicate-test'] }
  );
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Duplicate Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = userId;
  await thing.save();

  const review = await Review.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['duplicate-test'] }
  );
  review.thingID = thing.id;
  review.title = { en: 'Duplicate Test Review' };
  review.text = { en: 'Test content' };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = userId;
  await review.save();

  // Create a team
  const team = await Team.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['duplicate-test'] }
  );
  team.name = { en: 'Duplicate Test Team' };
  team.teamType = 'trusted users';
  team.createdOn = new Date();
  team.createdBy = userId;
  await team.save();

  // Associate once
  await Review.addManyRelated('teams', review.id!, [team.id!]);

  // Associate again (should not throw error due to ON CONFLICT DO NOTHING)
  await t.notThrowsAsync(async () => {
    await Review.addManyRelated('teams', review.id!, [team.id!]);
  });

  // Verify only one association exists
  const reviewTeamMap = await Review.loadManyRelated('teams', [review.id!]);
  t.is(reviewTeamMap.get(review.id!)?.length, 1);
});

test.serial('Model.addManyRelated handles empty target array gracefully', async t => {
  // Create a thing and review
  const userId = randomUUID();
  await ensureUserExists(dalFixture, userId);

  const thing = await Thing.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['empty-array-test'] }
  );
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Empty Array Test Thing' };
  thing.createdOn = new Date();
  thing.createdBy = userId;
  await thing.save();

  const review = await Review.createFirstRevision(
    { id: userId, is_super_user: false, is_trusted: true },
    { tags: ['empty-array-test'] }
  );
  review.thingID = thing.id;
  review.title = { en: 'Empty Array Test Review' };
  review.text = { en: 'Test content' };
  review.starRating = 3;
  review.createdOn = new Date();
  review.createdBy = userId;
  await review.save();

  // Call with empty array - should not throw
  await t.notThrowsAsync(async () => {
    await Review.addManyRelated('teams', review.id!, []);
  });

  // Verify no associations created
  const reviewTeamMap = await Review.loadManyRelated('teams', [review.id!]);
  t.is(reviewTeamMap.get(review.id!)?.length ?? 0, 0);
});

test.serial('Model.addManyRelated throws helpful error for invalid relation', async t => {
  const error = await t.throwsAsync(
    async () => await Review.addManyRelated('nonExistentRelation', 'some-id', ['target-id']),
    { instanceOf: Error }
  );

  t.true(error?.message.includes("Relation 'nonExistentRelation' not found"));
  t.true(error?.message.includes('Available relations:'));
});

test.serial('Model.addManyRelated throws error for non-junction relations', async t => {
  // Try to use addManyRelated on a direct relation (not through a junction table)
  // Using Thing model's 'reviews' relation which is a direct one-to-many
  const Thing = dalFixture.getModel('things');

  const error = await t.throwsAsync(
    async () => await Thing.addManyRelated('reviews', 'some-thing-id', ['review-id']),
    { instanceOf: Error }
  );

  t.true(error?.message.includes('not a many-to-many relation with a junction table'));
  t.true(error?.message.includes("Only relations with 'through' configuration"));
});

test.after.always(async () => {
  unmockSearch();
  await dalFixture.cleanup();
});
