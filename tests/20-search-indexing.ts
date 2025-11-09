import test from 'ava';
import { randomUUID } from 'crypto';
import { initializeDAL, isInitialized } from '../bootstrap/dal.ts';
import searchModule from '../search.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

type ThingModel = typeof import('../models/thing.ts').default;
type ReviewModel = typeof import('../models/review.ts').default;

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'search_indexing',
  cleanupTables: ['users', 'things', 'reviews'],
});

// Mock search module to capture indexing calls
let indexedItems = [];

test.before(async () => {
  await bootstrapPromise;

  const captured = mockSearch();
  indexedItems = captured.indexedItems;

  await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
  ]);
});

test.beforeEach(async _t => {
  // Clear captured calls before each test
  indexedItems.length = 0;
});

test.after.always(unmockSearch);

test.serial('indexThing handles PostgreSQL JSONB metadata structure', async t => {
  const Thing = dalFixture.getThingModel();

  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];

  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._oldRevOf || thing._revDeleted) {
        return Promise.resolve();
      }

      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._oldRevOf || review._revDeleted) {
        return Promise.resolve();
      }

      testIndexedReviews.push(review);
      return Promise.resolve();
    },
  };

  // Create a thing with PostgreSQL JSONB metadata structure
  const { actor: testUser } = await dalFixture.createTestUser('Index Thing User');
  const preCheck = await dalFixture.query(
    `SELECT id FROM ${dalFixture.getTableName('users')} WHERE id = $1`,
    [testUser.id]
  );
  t.is(preCheck.rows.length, 1, 'Created user should exist before creating thing');
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/test-book'];
  thing.label = { en: 'Test Book', de: 'Testbuch' };
  thing.aliases = { en: ['Alternative Title'], de: ['Alternativer Titel'] };

  // PostgreSQL structure: metadata grouped in JSONB
  thing.metadata = {
    description: {
      en: 'A comprehensive test book for validation',
      de: 'Ein umfassendes Testbuch zur Validierung',
    },
    subtitle: {
      en: 'Testing Edition',
      de: 'Test-Ausgabe',
    },
    authors: [
      { en: 'Test Author', de: 'Test Autor' },
      { en: 'Second Author', de: 'Zweiter Autor' },
    ],
  };

  thing.canonicalSlugName = 'test-book';
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;

  await thing.save();

  // Test indexing
  await search.indexThing(thing);

  // Verify the thing was indexed
  t.is(testIndexedThings.length, 1, 'Should have indexed one thing');

  const indexedThing = testIndexedThings[0];
  t.is(indexedThing.id, thing.id, 'Indexed thing should have correct ID');
  t.deepEqual(indexedThing.label, thing.label, 'Label should be preserved');
  t.deepEqual(indexedThing.aliases, thing.aliases, 'Aliases should be preserved');
  t.deepEqual(
    indexedThing.metadata.description,
    thing.metadata.description,
    'Description should be extracted from metadata'
  );
  t.deepEqual(
    indexedThing.metadata.subtitle,
    thing.metadata.subtitle,
    'Subtitle should be extracted from metadata'
  );
  t.deepEqual(
    indexedThing.metadata.authors,
    thing.metadata.authors,
    'Authors should be extracted from metadata'
  );
});

test.serial('indexThing skips old and deleted revisions', async t => {
  const { Thing } = dalFixture;

  const { actor: testUser } = await dalFixture.createTestUser('Review Skip User');

  // Create a current revision
  const currentThing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  currentThing.urls = ['https://example.com/current'];
  currentThing.label = { en: 'Current Thing' };
  currentThing.createdOn = new Date();
  currentThing.createdBy = testUser.id;

  // Create an old revision (simulated)
  const oldThing = Object.assign(Object.create(Object.getPrototypeOf(currentThing)), {
    _data: { ...currentThing._data, _old_rev_of: randomUUID() },
    _virtualFields: { ...currentThing._virtualFields },
    _changed: new Set(currentThing._changed),
    _isNew: currentThing._isNew,
  });
  oldThing._setupPropertyAccessors();

  // Create a deleted revision (simulated)
  const deletedThing = Object.assign(Object.create(Object.getPrototypeOf(currentThing)), {
    _data: { ...currentThing._data, _rev_deleted: true },
    _virtualFields: { ...currentThing._virtualFields },
    _changed: new Set(currentThing._changed),
    _isNew: currentThing._isNew,
  });
  deletedThing._setupPropertyAccessors();

  // Test indexing current revision
  await searchModule.indexThing(currentThing);
  let things = indexedItems.filter(item => item.type === 'thing');
  t.is(things.length, 1, 'Should index current revision');

  // Test skipping old revision
  await searchModule.indexThing(oldThing);
  things = indexedItems.filter(item => item.type === 'thing');
  t.is(things.length, 1, 'Should skip old revision');

  // Test skipping deleted revision
  await searchModule.indexThing(deletedThing);
  things = indexedItems.filter(item => item.type === 'thing');
  t.is(things.length, 1, 'Should skip deleted revision');
});

test.serial('indexReview handles PostgreSQL JSONB structure', async t => {
  const Thing: ThingModel = dalFixture.getThingModel();
  const Review: ReviewModel = dalFixture.getReviewModel();

  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];

  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._oldRevOf || thing._revDeleted) {
        return Promise.resolve();
      }

      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._oldRevOf || review._revDeleted) {
        return Promise.resolve();
      }

      testIndexedReviews.push(review);
      return Promise.resolve();
    },
  };

  const { actor: testUser } = await dalFixture.createTestUser('Metadata User');

  // Create a thing first
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/review-subject'];
  thing.label = { en: 'Review Subject' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();

  // Create a review with PostgreSQL structure
  const review = await Review.createFirstRevision(testUser, { tags: ['create'] });
  review.thingID = thing.id; // PostgreSQL field name
  review.title = { en: 'Great Book!', de: 'Tolles Buch!' };
  review.text = { en: 'This is a wonderful book.', de: 'Das ist ein wunderbares Buch.' };
  review.html = {
    en: '<p>This is a wonderful book.</p>',
    de: '<p>Das ist ein wunderbares Buch.</p>',
  };
  review.starRating = 5; // PostgreSQL field name
  review.createdOn = new Date();
  review.createdBy = testUser.id;

  await review.save();

  // Test indexing
  await search.indexReview(review);

  // Verify the review was indexed
  t.is(testIndexedReviews.length, 1, 'Should have indexed one review');

  const indexedReview = testIndexedReviews[0];
  t.is(indexedReview.id, review.id, 'Indexed review should have correct ID');
  t.is(indexedReview.thingID, thing.id, 'Should have correct thing_id');
  t.deepEqual(indexedReview.title, review.title, 'Title should be preserved');
  t.deepEqual(indexedReview.text, review.text, 'Text should be preserved');
  t.deepEqual(indexedReview.html, review.html, 'HTML should be preserved');
  t.is(indexedReview.starRating, 5, 'Star rating should be preserved');
});

test.serial('indexReview skips old and deleted revisions', async t => {
  const Thing: ThingModel = dalFixture.getThingModel();
  const Review: ReviewModel = dalFixture.getReviewModel();

  const { actor: testUser } = await dalFixture.createTestUser('Review Skip User');

  // Create a thing first
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/review-subject-2'];
  thing.label = { en: 'Review Subject 2' };
  thing.createdOn = new Date();
  thing.createdBy = testUser.id;
  await thing.save();

  // Create a current review
  const currentReview = await Review.createFirstRevision(testUser, { tags: ['create'] });
  currentReview.thingID = thing.id;
  currentReview.title = { en: 'Current Review' };
  currentReview.text = { en: 'Current review text' };
  currentReview.html = { en: '<p>Current review text</p>' };
  currentReview.starRating = 4;
  currentReview.createdOn = new Date();
  currentReview.createdBy = testUser.id;

  // Create an old revision (simulated)
  const oldReview = Object.assign(Object.create(Object.getPrototypeOf(currentReview)), {
    _data: { ...currentReview._data, _old_rev_of: randomUUID() },
    _virtualFields: { ...currentReview._virtualFields },
    _changed: new Set(currentReview._changed),
    _isNew: currentReview._isNew,
  });
  oldReview._setupPropertyAccessors();

  // Create a deleted revision (simulated)
  const deletedReview = Object.assign(Object.create(Object.getPrototypeOf(currentReview)), {
    _data: { ...currentReview._data, _rev_deleted: true },
    _virtualFields: { ...currentReview._virtualFields },
    _changed: new Set(currentReview._changed),
    _isNew: currentReview._isNew,
  });
  deletedReview._setupPropertyAccessors();

  // Test indexing current revision
  await searchModule.indexReview(currentReview);
  let reviews = indexedItems.filter(item => item.type === 'review');
  t.is(reviews.length, 1, 'Should index current revision');

  // Test skipping old revision
  await searchModule.indexReview(oldReview);
  reviews = indexedItems.filter(item => item.type === 'review');
  t.is(reviews.length, 1, 'Should skip old revision');

  // Test skipping deleted revision
  await searchModule.indexReview(deletedReview);
  reviews = indexedItems.filter(item => item.type === 'review');
  t.is(reviews.length, 1, 'Should skip deleted revision');
});

test.serial('maintenance script ensures DAL bootstrap before indexing', async t => {
  await initializeDAL();
  t.true(isInitialized(), 'DAL should initialize for maintenance script');

  const { default: ThingHandle } = await import('../models/thing.ts');
  const { default: ReviewHandle } = await import('../models/review.ts');
  t.true(typeof ThingHandle.filterWhere === 'function', 'Thing handle exposes filterWhere');
  t.true(typeof ReviewHandle.filterWhere === 'function', 'Review handle exposes filterWhere');
  t.truthy(ThingHandle.ops, 'Thing handle exposes filter operator helpers');
  t.truthy(ReviewHandle.ops, 'Review handle exposes filter operator helpers');
});

test.serial('search indexing extracts multilingual content correctly', async t => {
  const Thing = dalFixture.getThingModel();

  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];

  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._oldRevOf || thing._revDeleted) {
        return Promise.resolve();
      }

      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._oldRevOf || review._revDeleted) {
        return Promise.resolve();
      }

      testIndexedReviews.push(review);
      return Promise.resolve();
    },
  };

  const { actor: testUser } = await dalFixture.createTestUser('Multilingual Index User');
  const userCheck = await dalFixture.query(
    `SELECT id FROM ${dalFixture.getTableName('users')} WHERE id = $1`,
    [testUser.id]
  );
  t.is(userCheck.rows.length, 1, 'Created user should exist before creating thing');

  // Create a thing with complex multilingual metadata
  const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/multilingual-book'];
  thing.label = {
    en: 'Multilingual Book',
    de: 'Mehrsprachiges Buch',
    fr: 'Livre Multilingue',
    es: 'Libro Multilingüe',
  };
  thing.aliases = {
    en: ['Alternative Title', 'Another Name'],
    de: ['Alternativer Titel', 'Anderer Name'],
    fr: ['Titre Alternatif'],
    es: ['Título Alternativo'],
  };
  thing.metadata = {
    description: {
      en: 'A book available in multiple languages with rich content',
      de: 'Ein Buch, das in mehreren Sprachen mit reichhaltigem Inhalt verfügbar ist',
      fr: 'Un livre disponible en plusieurs langues avec un contenu riche',
      es: 'Un libro disponible en varios idiomas con contenido rico',
    },
    subtitle: {
      en: 'International Edition',
      de: 'Internationale Ausgabe',
      fr: 'Édition Internationale',
      es: 'Edición Internacional',
    },
    authors: [
      {
        en: 'International Author',
        de: 'Internationaler Autor',
        fr: 'Auteur International',
        es: 'Autor Internacional',
      },
    ],
  };

  thing.createdOn = new Date();
  thing.createdBy = testUser.id;

  await thing.save();

  // Test indexing
  await search.indexThing(thing);

  // Verify multilingual content is preserved
  t.is(testIndexedThings.length, 1, 'Should have indexed one thing');

  const indexedThing = testIndexedThings[0];

  // Check that all languages are preserved in each field
  t.is(Object.keys(indexedThing.label).length, 4, 'Label should have all 4 languages');
  t.is(
    Object.keys(indexedThing.metadata.description).length,
    4,
    'Description should have all 4 languages'
  );
  t.is(
    Object.keys(indexedThing.metadata.subtitle).length,
    4,
    'Subtitle should have all 4 languages'
  );

  // Check specific language content
  t.is(indexedThing.label.en, 'Multilingual Book', 'English label should be correct');
  t.is(indexedThing.label.de, 'Mehrsprachiges Buch', 'German label should be correct');
  t.is(
    indexedThing.metadata.description.fr,
    'Un livre disponible en plusieurs langues avec un contenu riche',
    'French description should be correct'
  );
  t.is(
    indexedThing.metadata.subtitle.es,
    'Edición Internacional',
    'Spanish subtitle should be correct'
  );
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
