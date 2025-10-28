import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';

const require = createRequire(import.meta.url);

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

  const reviewer = await User.create({
    name: `Reviewer-${randomUUID()}`,
    password: 'secret123',
    email: `reviewer-${randomUUID()}@example.com`
  });

  const otherUser = await User.create({
    name: `Other-${randomUUID()}`,
    password: 'secret123',
    email: `other-${randomUUID()}@example.com`
  });

  const url = `https://example.com/review-${randomUUID()}`;

  const thingRev = await Thing.createFirstRevision(reviewer, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Review Target' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = reviewer.id;
  const thing = await thingRev.save();

  const reviewRev = await Review.createFirstRevision(reviewer, { tags: ['create'] });
  reviewRev.thingID = thing.id;
  reviewRev.starRating = 4;
  reviewRev.createdOn = new Date();
  reviewRev.createdBy = reviewer.id;
  reviewRev.originalLanguage = 'en';
  reviewRev.title = { en: 'Solid review' };
  reviewRev.text = { en: 'Plenty of useful detail.' };
  const review = await reviewRev.save();

  const resultsForReviewer = await Thing.lookupByURL(url, reviewer.id);
  t.is(resultsForReviewer.length, 1, 'Lookup returns the thing for reviewer');
  t.true(Array.isArray(resultsForReviewer[0].reviews), 'Reviews array is present for reviewer');
  t.is(resultsForReviewer[0].reviews.length, 1, 'Reviewer sees their review');
  t.is(resultsForReviewer[0].reviews[0].id, review.id, 'Reviewer review is returned');

  const resultsForOtherUser = await Thing.lookupByURL(url, otherUser.id);
  t.is(resultsForOtherUser.length, 1, 'Lookup returns the thing for other user');
  t.true(Array.isArray(resultsForOtherUser[0].reviews), 'Reviews array present for other user');
  t.is(resultsForOtherUser[0].reviews.length, 0, 'Other user sees no reviews');
});

test.serial('Thing-Review: relationship and metrics', async t => {

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const reviewer1 = await User.create({
    name: `Reviewer1-${randomUUID()}`,
    password: 'secret123',
    email: `reviewer1-${randomUUID()}@example.com`
  });

  const reviewer2 = await User.create({
    name: `Reviewer2-${randomUUID()}`,
    password: 'secret123',
    email: `reviewer2-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/integration-test-${randomUUID()}`];
  thingRev.label = { en: 'Integration Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');
  
  const review1 = new Review({
    thing_id: thing.id,
    title: { en: 'Great Product' },
    text: { en: 'I love this product!' },
    star_rating: 5,
    created_on: new Date(),
    created_by: reviewer1.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer1.id,
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
    created_by: reviewer2.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer2.id,
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

  const teamFounder = await User.create({
    name: `TeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `teamfounder-${randomUUID()}@example.com`
  });

  const reviewer = await User.create({
    name: `TeamReviewer-${randomUUID()}`,
    password: 'secret123',
    email: `teamreviewer-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const teamRev = await Team.createFirstRevision(teamFounder, { tags: ['create'] });
  teamRev.name = { en: 'Review Team' };
  teamRev.createdBy = teamFounder.id;
  teamRev.createdOn = new Date();
  const team = await teamRev.save();

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/team-review-test-${randomUUID()}`];
  thingRev.label = { en: 'Team Review Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');
  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Team Review' },
    text: { en: 'This is a review from our team.' },
    star_rating: 4,
    created_on: new Date(),
    created_by: reviewer.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review.save();

  const reviewTeamTableName = dalFixture.tablePrefix ? 
    `${dalFixture.tablePrefix}review_teams` : 'review_teams';
  
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

  const teamFounder = await User.create({
    name: `CreateTeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `createteamfounder-${randomUUID()}@example.com`
  });

  const reviewer = await User.create({
    name: `CreateReviewer-${randomUUID()}`,
    password: 'secret123',
    email: `createreviewer-${randomUUID()}@example.com`
  });

  const teamRev = await Team.createFirstRevision(teamFounder, { tags: ['create'] });
  teamRev.name = { en: 'Create Review Team' };
  teamRev.createdBy = teamFounder.id;
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
    createdBy: reviewer.id,
    originalLanguage: 'en',
    teams: [team]
  };

  const review = await Review.create(reviewObj, { tags: ['create'] });

  t.truthy(review.id, 'Review created successfully');
  t.truthy(review.thingID, 'Thing created for review');

  const reviewTeamTableName = dalFixture.tablePrefix ? 
    `${dalFixture.tablePrefix}review_teams` : 'review_teams';
  
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

  const user = await User.create({
    name: `RevisionUser-${randomUUID()}`,
    password: 'secret123',
    email: `revisionuser-${randomUUID()}@example.com`
  });

  const thingRev1 = await Thing.createFirstRevision(user, { tags: ['create'] });
  thingRev1.urls = [`https://example.com/revision-integration-${randomUUID()}`];
  thingRev1.label = { en: 'Original Thing Label' };
  thingRev1.createdOn = new Date();
  thingRev1.createdBy = user.id;
  await thingRev1.save();

  const thingRev2 = await thingRev1.newRevision(user, { tags: ['edit'] });
  thingRev2.label = { en: 'Updated Thing Label' };
  await thingRev2.save();

  const teamRev1 = await Team.createFirstRevision(user, { tags: ['create'] });
  teamRev1.name = { en: 'Original Team Name' };
  teamRev1.createdBy = user.id;
  teamRev1.createdOn = new Date();
  await teamRev1.save();

  const teamRev2 = await teamRev1.newRevision(user, { tags: ['edit'] });
  teamRev2.name = { en: 'Updated Team Name' };
  await teamRev2.save();

  const { randomUUID: uuid } = require('crypto');
  const reviewRev1 = new Review({
    thing_id: thingRev1.id,
    title: { en: 'Original Review Title' },
    text: { en: 'Original review content' },
    star_rating: 3,
    created_on: new Date(),
    created_by: user.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await reviewRev1.save();

  const reviewRev2 = await reviewRev1.newRevision(user, { tags: ['edit'] });
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
