import test from 'ava';
import { randomUUID } from 'crypto';
import { ReviewError } from '../models/review.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'review_model',
  cleanupTables: ['reviews', 'things', 'users'],
});

let User, Thing, Review;
test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
  ]);

  User = models.User;
  Thing = models.Thing;
  Review = models.Review;
});

test.after.always(unmockSearch);

// ============================================================================
// REVIEW MODEL BASIC TESTS
// ============================================================================

test.serial('Review model: create review with JSONB multilingual content', async t => {
  const { actor: author } = await dalFixture.createTestUser('Review Author');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator');

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
    fr: 'Excellent Produit',
  };
  review.text = {
    en: 'This is an excellent product that I highly recommend.',
    de: 'Dies ist ein ausgezeichnetes Produkt, das ich sehr empfehle.',
    fr: "C'est un excellent produit que je recommande vivement.",
  };
  review.html = {
    en: '<p>This is an <strong>excellent</strong> product that I highly recommend.</p>',
    de: '<p>Dies ist ein <strong>ausgezeichnetes</strong> Produkt, das ich sehr empfehle.</p>',
    fr: "<p>C'est un <strong>excellent</strong> produit que je recommande vivement.</p>",
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
  const { actor: author } = await dalFixture.createTestUser('Rating Author');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator');

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/rating-test-${randomUUID()}`];
  thingRev.label = { en: 'Rating Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

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
      _rev_id: randomUUID(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create'],
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
      _rev_id: randomUUID(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create'],
    });

    const saved = await review.save();
    t.is(saved.starRating, rating, `Rating ${rating} should be valid`);
  }
});

test.serial('Review model: populateUserInfo sets permission flags correctly', async t => {
  const { actor: author } = await dalFixture.createTestUser('Review Author');
  const { actor: moderatorActor } = await dalFixture.createTestUser('Review Moderator');
  const { actor: otherUser } = await dalFixture.createTestUser('Other User');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator');

  // Load and configure moderator
  const moderator = await User.get(moderatorActor.id);
  moderator.isSiteModerator = true;
  await moderator.save();

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/reviewable-${randomUUID()}`];
  thingRev.label = { en: 'Reviewable Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Test Review' },
    text: { en: 'Test review content' },
    star_rating: 4,
    created_on: new Date(),
    created_by: author.id,
    original_language: 'en',
    _rev_id: randomUUID(),
    _rev_user: author.id,
    _rev_date: new Date(),
    _rev_tags: ['create'],
  });
  await review.save();

  // Load full User objects for populateUserInfo
  const fullAuthor = await User.get(author.id);
  const fullOtherUser = await User.get(otherUser.id);

  review.populateUserInfo(fullAuthor);
  t.true(review.userIsAuthor, 'Author recognized');
  t.true(review.userCanEdit, 'Author can edit');
  t.true(review.userCanDelete, 'Author can delete');

  const moderatorView = await Review.get(review.id);
  moderatorView.populateUserInfo(moderator);
  t.false(moderatorView.userIsAuthor, 'Moderator not author');
  t.false(moderatorView.userCanEdit, 'Moderator cannot edit (not author)');
  t.true(moderatorView.userCanDelete, 'Moderator can delete');

  const otherView = await Review.get(review.id);
  otherView.populateUserInfo(fullOtherUser);
  t.false(otherView.userIsAuthor, 'Other user not author');
  t.false(otherView.userCanEdit, 'Other user cannot edit');
  t.false(otherView.userCanDelete, 'Other user cannot delete');
});

test.serial(
  'Review model: deleteAllRevisionsWithThing deletes review and associated thing',
  async t => {
    const { actor: author } = await dalFixture.createTestUser('Delete Author');
    const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator');

    const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
    thingRev.urls = [`https://example.com/delete-test-${randomUUID()}`];
    thingRev.label = { en: 'Thing to Delete' };
    thingRev.createdOn = new Date();
    thingRev.createdBy = thingCreator.id;
    const thing = await thingRev.save();

    const reviewRev = await Review.createFirstRevision(author, { tags: ['create'] });
    reviewRev.thingID = thing.id;
    reviewRev.title = { en: 'Review to Delete' };
    reviewRev.text = { en: 'This review will be deleted.' };
    reviewRev.starRating = 3;
    reviewRev.createdOn = new Date();
    reviewRev.createdBy = author.id;
    reviewRev.originalLanguage = 'en';
    const review = await reviewRev.save();

    const reviewRevId1 = review._data._rev_id;
    const thingID = review.thingID;

    const newRev = await review.newRevision(author, { tags: ['edit'] });
    newRev.title = { en: 'Updated Review to Delete' };
    const savedRev = await newRev.save();
    const reviewRevId2 = savedRev._data._rev_id;

    savedRev.thing = await Thing.get(savedRev.thingID);
    await savedRev.deleteAllRevisionsWithThing(author);

    const deletedReview1 = await Review.filter({ _revID: reviewRevId1 }).run();
    const deletedReview2 = await Review.filter({ _revID: reviewRevId2 }).run();
    const deletedThing = await Thing.get(thingID);

    t.true(deletedReview1[0]._data._rev_deleted, 'Original review revision marked as deleted');
    t.true(deletedReview2[0]._data._rev_deleted, 'Updated review revision marked as deleted');
    t.true(deletedThing._data._rev_deleted, 'Associated thing marked as deleted');

    await t.throwsAsync(
      () => Review.getNotStaleOrDeleted(review.id),
      { name: 'RevisionDeletedError' },
      'Getting deleted review throws error'
    );

    await t.throwsAsync(
      () => Thing.getNotStaleOrDeleted(thingID),
      { name: 'RevisionDeletedError' },
      'Getting deleted thing throws error'
    );
  }
);

// ============================================================================
// REVIEW FEED AND PAGINATION TESTS
// ============================================================================

test.serial('Review model: getFeed returns reviews with pagination', async t => {
  const { actor: author } = await dalFixture.createTestUser('Feed Author');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator');

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
  t.true(
    offsetDate instanceof Date && !Number.isNaN(offsetDate.valueOf()),
    'Received pagination offset date'
  );

  const secondPage = await Review.getFeed({ limit: 3, offsetDate });
  const { feedItems: secondPageItems } = secondPage;

  t.is(secondPageItems.length, 3, 'Received expected number of additional feed items');
  t.true(
    secondPageItems[0].createdOn.valueOf() < offsetDate.valueOf(),
    'Feed items received with pagination offset are older than earlier ones'
  );
});

test.serial('Review model: getFeed joins thing data', async t => {
  const { actor: author } = await dalFixture.createTestUser('Join Author');
  const { actor: thingCreator } = await dalFixture.createTestUser('Join Thing Creator');

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
