import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';

const require = createRequire(import.meta.url);

const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
  schemaNamespace: 'review_model',
  cleanupTables: ['reviews', 'things', 'users']
});

let User, Thing, Review;
let ReviewError;

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' }
  ]);

  User = models.User;
  Thing = models.Thing;
  Review = models.Review;

  ({ ReviewError } = require('../models/review'));
});

test.after.always(unmockSearch);

async function skipIfNoModels(t) {
  if (await skipIfUnavailable(t)) return true;
  if (!User || !Thing || !Review) {
    const skipMessage = 'Skipping - PostgreSQL DAL not available';
    t.log(skipMessage);
    t.pass(skipMessage);
    return true;
  }
  return false;
}

// ============================================================================
// REVIEW MODEL BASIC TESTS
// ============================================================================

test.serial('Review model: create review with JSONB multilingual content', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `ReviewAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `reviewauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/reviewable-${randomUUID()}`];
  thingRev.label = { en: 'Reviewable Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const review = await Review.createFirstRevision(author, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = {
    en: 'Great Product',
    de: 'Tolles Produkt',
    fr: 'Excellent Produit'
  };
  review.text = {
    en: 'This is an excellent product that I highly recommend.',
    de: 'Dies ist ein ausgezeichnetes Produkt, das ich sehr empfehle.',
    fr: 'C\'est un excellent produit que je recommande vivement.'
  };
  review.html = {
    en: '<p>This is an <strong>excellent</strong> product that I highly recommend.</p>',
    de: '<p>Dies ist ein <strong>ausgezeichnetes</strong> Produkt, das ich sehr empfehle.</p>',
    fr: '<p>C\'est un <strong>excellent</strong> produit que je recommande vivement.</p>'
  };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = author.id;
  review.originalLanguage = 'en';

  const saved = await review.save();
  
  t.truthy(saved.id, 'Review saved with generated UUID');
  t.deepEqual(saved.title, review.title, 'Multilingual title stored correctly');
  t.deepEqual(saved.text, review.text, 'Multilingual text stored correctly');
  t.deepEqual(saved.html, review.html, 'Multilingual HTML stored correctly');
  t.is(saved.starRating, 5, 'Star rating stored correctly');
  t.is(saved.thingID, thing.id, 'Thing relationship stored correctly');
});

test.serial('Review model: star rating validation works', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `RatingAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `ratingauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/rating-test-${randomUUID()}`];
  thingRev.label = { en: 'Rating Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');

  const invalidRatings = [0, 6, -1, 3.5, 'five'];
  
  for (const rating of invalidRatings) {
    const review = new Review({
      thing_id: thing.id,
      title: { en: 'Invalid Rating Test' },
      text: { en: 'Testing invalid rating' },
      star_rating: rating,
      created_on: new Date(),
      created_by: author.id,
      original_language: 'en',
      _rev_id: uuid(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });

    await t.throwsAsync(() => review.save(), undefined, `Rating ${rating} should be invalid`);
  }

  const validRatings = [1, 2, 3, 4, 5];
  
  for (const rating of validRatings) {
    const review = new Review({
      thing_id: thing.id,
      title: { en: `Valid Rating ${rating}` },
      text: { en: `Testing valid rating ${rating}` },
      star_rating: rating,
      created_on: new Date(),
      created_by: author.id,
      original_language: 'en',
      _rev_id: uuid(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });

    const saved = await review.save();
    t.is(saved.starRating, rating, `Rating ${rating} should be valid`);
  }
});

test.serial('Review model: populateUserInfo sets permission flags correctly', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `ReviewAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `reviewauthor-${randomUUID()}@example.com`
  });

  const moderator = await User.create({
    name: `ReviewModerator-${randomUUID()}`,
    password: 'secret123',
    email: `reviewmoderator-${randomUUID()}@example.com`
  });
  moderator.isSiteModerator = true;
  await moderator.save();

  const otherUser = await User.create({
    name: `OtherUser-${randomUUID()}`,
    password: 'secret123',
    email: `otheruser-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/reviewable-${randomUUID()}`];
  thingRev.label = { en: 'Reviewable Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');
  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Test Review' },
    text: { en: 'Test review content' },
    star_rating: 4,
    created_on: new Date(),
    created_by: author.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: author.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review.save();

  review.populateUserInfo(author);
  t.true(review.userIsAuthor, 'Author recognized');
  t.true(review.userCanEdit, 'Author can edit');
  t.true(review.userCanDelete, 'Author can delete');

  const moderatorView = await Review.get(review.id);
  moderatorView.populateUserInfo(moderator);
  t.false(moderatorView.userIsAuthor, 'Moderator not author');
  t.false(moderatorView.userCanEdit, 'Moderator cannot edit (not author)');
  t.true(moderatorView.userCanDelete, 'Moderator can delete');

  const otherView = await Review.get(review.id);
  otherView.populateUserInfo(otherUser);
  t.false(otherView.userIsAuthor, 'Other user not author');
  t.false(otherView.userCanEdit, 'Other user cannot edit');
  t.false(otherView.userCanDelete, 'Other user cannot delete');
});

// ============================================================================
// REVIEW FEED AND PAGINATION TESTS
// ============================================================================

test.serial('Review model: getFeed returns reviews with pagination', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `FeedAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `feedauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const baseTime = new Date('2025-01-01T12:00:00Z');
  
  for (let i = 0; i < 5; i++) {
    const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
    thingRev.urls = [`https://example.com/pagination-${randomUUID()}`];
    thingRev.label = { en: `Thing ${i}` };
    thingRev.createdOn = baseTime;
    thingRev.createdBy = thingCreator.id;
    const thing = await thingRev.save();

    const reviewRev = await Review.createFirstRevision(author, { tags: ['create'] });
    reviewRev.thingID = thing.id;
    reviewRev.title = { en: `Review ${i}` };
    reviewRev.text = { en: `Review content ${i}` };
    reviewRev.html = { en: `<p>Review content ${i}</p>` };
    reviewRev.starRating = (i % 5) + 1;
    reviewRev.createdOn = new Date(baseTime.getTime() + i * 1000);
    reviewRev.createdBy = author.id;
    reviewRev.originalLanguage = 'en';
    await reviewRev.save();
  }

  const firstPage = await Review.getFeed({ limit: 2 });
  const { offsetDate, feedItems } = firstPage;

  t.is(feedItems.length, 2, 'Received expected number of feed items');
  t.true(offsetDate instanceof Date && !isNaN(offsetDate), 'Received pagination offset date');

  const secondPage = await Review.getFeed({ limit: 3, offsetDate });
  const { feedItems: secondPageItems } = secondPage;

  t.is(secondPageItems.length, 3, 'Received expected number of additional feed items');
  t.true(
    secondPageItems[0].createdOn.valueOf() < offsetDate.valueOf(),
    'Feed items received with pagination offset are older than earlier ones'
  );
});

test.serial('Review model: getFeed joins thing data', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `JoinAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `joinauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `JoinThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `jointhingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  const reviewUrl = `https://example.com/reviewable-${randomUUID()}`;
  const createdAt = new Date();

  thingRev.urls = [reviewUrl];
  thingRev.label = { en: 'Feed Thing' };
  thingRev.createdOn = createdAt;
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const reviewRev = await Review.createFirstRevision(author, { tags: ['create'] });
  reviewRev.thingID = thing.id;
  reviewRev.title = { en: 'Feed Review' };
  reviewRev.text = { en: 'Feed review content' };
  reviewRev.html = { en: '<p>Feed review content</p>' };
  reviewRev.starRating = 4;
  reviewRev.createdOn = createdAt;
  reviewRev.createdBy = author.id;
  reviewRev.originalLanguage = 'en';
  await reviewRev.save();

  const feed = await Review.getFeed({ limit: 5, withThing: true, withTeams: false });
  t.true(Array.isArray(feed.feedItems), 'Feed items array returned');
  t.true(feed.feedItems.length > 0, 'Feed includes created review');

  const [firstItem] = feed.feedItems;
  t.truthy(firstItem.thing, 'Thing join included in feed item');
  t.is(firstItem.thing.id, thing.id, 'Thing join matches review thing ID');
  t.is(firstItem.thing.label.en, 'Feed Thing', 'Thing label preserved in join');
  t.is(firstItem.thing.urls[0], reviewUrl, 'Thing URLs included in join');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
