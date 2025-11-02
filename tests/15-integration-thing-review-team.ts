import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.ts';

const uuid = randomUUID;

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'integration_thing_review_team',
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

test.after.always(unmockSearch);

// ============================================================================
// THING-REVIEW INTEGRATION TESTS
// ============================================================================

test.serial('Thing-Review: lookupByURL attaches reviews for requesting user', async t => {

  const reviewerData = await dalFixture.createTestUser('Reviewer');
  const otherUserData = await dalFixture.createTestUser('Other User');

  const url = `https://example.com/review-${randomUUID()}`;

  const thingRev = await Thing.createFirstRevision(reviewerData.actor, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Review Target' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = reviewerData.id;
  const thing = await thingRev.save();

  const reviewRev = await Review.createFirstRevision(reviewerData.actor, { tags: ['create'] });
  reviewRev.thingID = thing.id;
  reviewRev.starRating = 4;
  reviewRev.createdOn = new Date();
  reviewRev.createdBy = reviewerData.id;
  reviewRev.originalLanguage = 'en';
  reviewRev.title = { en: 'Solid review' };
  reviewRev.text = { en: 'Plenty of useful detail.' };
  const review = await reviewRev.save();

  const resultsForReviewer = await Thing.lookupByURL(url, reviewerData.id);
  t.is(resultsForReviewer.length, 1, 'Lookup returns the thing for reviewer');
  t.true(Array.isArray(resultsForReviewer[0].reviews), 'Reviews array is present for reviewer');
  t.is(resultsForReviewer[0].reviews.length, 1, 'Reviewer sees their review');
  t.is(resultsForReviewer[0].reviews[0].id, review.id, 'Reviewer review is returned');

  const resultsForOtherUser = await Thing.lookupByURL(url, otherUserData.id);
  t.is(resultsForOtherUser.length, 1, 'Lookup returns the thing for other user');
  t.true(Array.isArray(resultsForOtherUser[0].reviews), 'Reviews array present for other user');
  t.is(resultsForOtherUser[0].reviews.length, 0, 'Other user sees no reviews');
});

test.serial('Thing-Review: relationship and metrics', async t => {

  const thingCreatorData = await dalFixture.createTestUser('Thing Creator');
  const reviewer1Data = await dalFixture.createTestUser('Reviewer 1');
  const reviewer2Data = await dalFixture.createTestUser('Reviewer 2');

  const thingRev = await Thing.createFirstRevision(thingCreatorData.actor, { tags: ['create'] });
  thingRev.urls = [`https://example.com/integration-test-${randomUUID()}`];
  thingRev.label = { en: 'Integration Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreatorData.id;
  const thing = await thingRev.save();

  const review1 = new Review({
    thing_id: thing.id,
    title: { en: 'Great Product' },
    text: { en: 'I love this product!' },
    star_rating: 5,
    created_on: new Date(),
    created_by: reviewer1Data.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer1Data.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review1.save();

  const review2 = new Review({
    thing_id: thing.id,
    title: { en: 'Good but not perfect' },
    text: { en: 'It has some issues but overall good.' },
    star_rating: 3,
    created_on: new Date(),
    created_by: reviewer2Data.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer2Data.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review2.save();

  const avgRating = await thing.getAverageStarRating();
  const reviewCount = await thing.getReviewCount();
  
  t.is(avgRating, 4, 'Average rating calculated correctly (5+3)/2 = 4');
  t.is(reviewCount, 2, 'Review count calculated correctly');

  await thing.populateReviewMetrics();
  t.is(thing.averageStarRating, 4, 'Average rating populated correctly');
  t.is(thing.numberOfReviews, 2, 'Review count populated correctly');
});

// ============================================================================
// TEAM-REVIEW INTEGRATION TESTS
// ============================================================================

test.serial('Team-Review: association', async t => {

  const teamFounderData = await dalFixture.createTestUser('Team Founder');
  const reviewerData = await dalFixture.createTestUser('Team Reviewer');
  const thingCreatorData = await dalFixture.createTestUser('Thing Creator');

  const teamRev = await Team.createFirstRevision(teamFounderData.actor, { tags: ['create'] });
  teamRev.name = { en: 'Review Team' };
  teamRev.createdBy = teamFounderData.id;
  teamRev.createdOn = new Date();
  const team = await teamRev.save();

  const thingRev = await Thing.createFirstRevision(thingCreatorData.actor, { tags: ['create'] });
  thingRev.urls = [`https://example.com/team-review-test-${randomUUID()}`];
  thingRev.label = { en: 'Team Review Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreatorData.id;
  const thing = await thingRev.save();

  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Team Review' },
    text: { en: 'This is a review from our team.' },
    star_rating: 4,
    created_on: new Date(),
    created_by: reviewerData.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewerData.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review.save();

  const reviewTeamTableName = dalFixture.schemaNamespace ? 
    `${dalFixture.schemaNamespace}review_teams` : 'review_teams';
  
  await dalFixture.query(
    `INSERT INTO ${reviewTeamTableName} (review_id, team_id) VALUES ($1, $2)`,
    [review.id, team.id]
  );

  const associationResult = await dalFixture.query(
    `SELECT * FROM ${reviewTeamTableName} WHERE review_id = $1 AND team_id = $2`,
    [review.id, team.id]
  );
  
  t.is(associationResult.rows.length, 1, 'Review-team association created');
  t.is(associationResult.rows[0].review_id, review.id, 'Review ID matches');
  t.is(associationResult.rows[0].team_id, team.id, 'Team ID matches');
});

test.serial('Team-Review: Review.create with team associations', async t => {

  const teamFounderData = await dalFixture.createTestUser('Create Team Founder');
  const reviewerData = await dalFixture.createTestUser('Create Reviewer');

  const teamRev = await Team.createFirstRevision(teamFounderData.actor, { tags: ['create'] });
  teamRev.name = { en: 'Create Review Team' };
  teamRev.createdBy = teamFounderData.id;
  teamRev.createdOn = new Date();
  const team = await teamRev.save();

  const reviewUrl = `https://example.com/create-team-review-${randomUUID()}`;
  const reviewObj = {
    url: reviewUrl,
    title: { en: 'Team Review via Create' },
    text: { en: 'This review was created with team associations.' },
    html: { en: '<p>This review was created with team associations.</p>' },
    starRating: 5,
    createdOn: new Date(),
    createdBy: reviewerData.id,
    originalLanguage: 'en',
    teams: [team]
  };

  const review = await Review.create(reviewObj, { tags: ['create'] });

  t.truthy(review.id, 'Review created successfully');
  t.truthy(review.thingID, 'Thing created for review');

  const reviewTeamTableName = dalFixture.schemaNamespace ? 
    `${dalFixture.schemaNamespace}review_teams` : 'review_teams';
  
  const associationResult = await dalFixture.query(
    `SELECT * FROM ${reviewTeamTableName} WHERE review_id = $1 AND team_id = $2`,
    [review.id, team.id]
  );
  
  t.is(associationResult.rows.length, 1, 'Team association created via Review.create');
  t.is(associationResult.rows[0].review_id, review.id, 'Review ID matches in association');
  t.is(associationResult.rows[0].team_id, team.id, 'Team ID matches in association');

  const reviewWithData = await Review.getWithData(review.id);
  t.truthy(reviewWithData.teams, 'Teams included in getWithData');
  t.is(reviewWithData.teams.length, 1, 'One team associated');
  t.is(reviewWithData.teams[0].id, team.id, 'Correct team associated');
});

// ============================================================================
// CROSS-MODEL REVISION TESTS
// ============================================================================

test.serial('Revision system across Thing, Review, and Team models', async t => {

  const userData = await dalFixture.createTestUser('Revision User');

  const thingRev1 = await Thing.createFirstRevision(userData.actor, { tags: ['create'] });
  thingRev1.urls = [`https://example.com/revision-integration-${randomUUID()}`];
  thingRev1.label = { en: 'Original Thing Label' };
  thingRev1.createdOn = new Date();
  thingRev1.createdBy = userData.id;
  await thingRev1.save();

  const thingRev2 = await thingRev1.newRevision(userData.actor, { tags: ['edit'] });
  thingRev2.label = { en: 'Updated Thing Label' };
  await thingRev2.save();

  const teamRev1 = await Team.createFirstRevision(userData.actor, { tags: ['create'] });
  teamRev1.name = { en: 'Original Team Name' };
  teamRev1.createdBy = userData.id;
  teamRev1.createdOn = new Date();
  await teamRev1.save();

  const teamRev2 = await teamRev1.newRevision(userData.actor, { tags: ['edit'] });
  teamRev2.name = { en: 'Updated Team Name' };
  await teamRev2.save();

  const reviewRev1 = new Review({
    thing_id: thingRev1.id,
    title: { en: 'Original Review Title' },
    text: { en: 'Original review content' },
    star_rating: 3,
    created_on: new Date(),
    created_by: userData.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: userData.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await reviewRev1.save();

  const reviewRev2 = await reviewRev1.newRevision(userData.actor, { tags: ['edit'] });
  reviewRev2.title = { en: 'Updated Review Title' };
  reviewRev2.text = { en: 'Updated review content' };
  await reviewRev2.save();

  const currentThing = await Thing.getNotStaleOrDeleted(thingRev1.id);
  const currentTeam = await Team.getNotStaleOrDeleted(teamRev1.id);
  const currentReview = await Review.getNotStaleOrDeleted(reviewRev1.id);

  t.is(currentThing.label.en, 'Updated Thing Label', 'Thing current revision correct');
  t.is(currentTeam.name.en, 'Updated Team Name', 'Team current revision correct');
  t.is(currentReview.title.en, 'Updated Review Title', 'Review current revision correct');

  const thingRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Thing.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [thingRev1.id]
  );
  const teamRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Team.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [teamRev1.id]
  );
  const reviewRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Review.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [reviewRev1.id]
  );

  t.is(parseInt(thingRevisions.rows[0].count), 2, 'Thing has 2 revisions');
  t.is(parseInt(teamRevisions.rows[0].count), 2, 'Team has 2 revisions');
  t.is(parseInt(reviewRevisions.rows[0].count), 2, 'Review has 2 revisions');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
