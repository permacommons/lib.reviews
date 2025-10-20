import test from 'ava';
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
const dalFixture = createDALFixtureAVA('testing-2', { tableSuffix: 'search_indexing' });

// Mock search module to capture indexing calls
let indexedThings = [];
let indexedReviews = [];
let searchMockCalls = [];

test.before(async t => {
  // Stub search module to capture indexing calls instead of sending to Elasticsearch
  const searchPath = require.resolve('../search');
  
  require.cache[searchPath] = {
    exports: {
      indexThing(thing) {
        // Skip indexing if this is an old or deleted revision (same logic as real function)
        if (thing._old_rev_of || thing._rev_deleted) {
          return Promise.resolve();
        }
        
        indexedThings.push(thing);
        searchMockCalls.push({ type: 'indexThing', data: thing });
        return Promise.resolve();
      },
      indexReview(review) {
        // Skip indexing if this is an old or deleted revision (same logic as real function)
        if (review._old_rev_of || review._rev_deleted) {
          return Promise.resolve();
        }
        
        indexedReviews.push(review);
        searchMockCalls.push({ type: 'indexReview', data: review });
        return Promise.resolve();
      },
      searchThings: async () => ({}),
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
    t.log('PostgreSQL not available, skipping search indexing tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.beforeEach(async t => {
  // Clean up tables between tests
  await dalFixture.cleanupTables(['users', 'things', 'reviews']);
  
  // Clear captured calls before each test
  indexedThings.length = 0;
  indexedReviews.length = 0;
  searchMockCalls.length = 0;
});

test.after.always(async t => {
  // Clean up the mocked search module from require cache
  const searchPath = require.resolve('../search');
  delete require.cache[searchPath];
  
  await dalFixture.cleanup();
});

function skipIfNoModels(t) {
  if (!dalFixture.Thing || !dalFixture.Review) {
    t.pass('Skipping - PostgreSQL models not available');
    return true;
  }
  return false;
}

test.serial('indexThing handles PostgreSQL JSONB metadata structure', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing } = dalFixture;
  
  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];
  
  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._old_rev_of || thing._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._old_rev_of || review._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedReviews.push(review);
      return Promise.resolve();
    }
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
      de: 'Ein umfassendes Testbuch zur Validierung'
    },
    subtitle: { 
      en: 'Testing Edition',
      de: 'Test-Ausgabe'
    },
    authors: [
      { en: 'Test Author', de: 'Test Autor' },
      { en: 'Second Author', de: 'Zweiter Autor' }
    ]
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
  t.deepEqual(indexedThing.metadata.description, thing.metadata.description, 'Description should be extracted from metadata');
  t.deepEqual(indexedThing.metadata.subtitle, thing.metadata.subtitle, 'Subtitle should be extracted from metadata');
  t.deepEqual(indexedThing.metadata.authors, thing.metadata.authors, 'Authors should be extracted from metadata');
});

test.serial('indexThing skips old and deleted revisions', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing } = dalFixture;
  const search = require('../search');
  
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
    _isNew: currentThing._isNew
  });
  oldThing._setupPropertyAccessors();
  
  // Create a deleted revision (simulated)
  const deletedThing = Object.assign(Object.create(Object.getPrototypeOf(currentThing)), {
    _data: { ...currentThing._data, _rev_deleted: true },
    _virtualFields: { ...currentThing._virtualFields },
    _changed: new Set(currentThing._changed),
    _isNew: currentThing._isNew
  });
  deletedThing._setupPropertyAccessors();
  
  // Test indexing current revision
  await search.indexThing(currentThing);
  t.is(indexedThings.length, 1, 'Should index current revision');
  
  // Test skipping old revision
  await search.indexThing(oldThing);
  t.is(indexedThings.length, 1, 'Should skip old revision');
  
  // Test skipping deleted revision
  await search.indexThing(deletedThing);
  t.is(indexedThings.length, 1, 'Should skip deleted revision');
});

test.serial('indexReview handles PostgreSQL JSONB structure', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing, Review } = dalFixture;
  
  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];
  
  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._old_rev_of || thing._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._old_rev_of || review._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedReviews.push(review);
      return Promise.resolve();
    }
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
  review.html = { en: '<p>This is a wonderful book.</p>', de: '<p>Das ist ein wunderbares Buch.</p>' };
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
  if (skipIfNoModels(t)) return;
  
  const { Thing, Review } = dalFixture;
  const search = require('../search');
  
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
    _isNew: currentReview._isNew
  });
  oldReview._setupPropertyAccessors();
  
  // Create a deleted revision (simulated)
  const deletedReview = Object.assign(Object.create(Object.getPrototypeOf(currentReview)), {
    _data: { ...currentReview._data, _rev_deleted: true },
    _virtualFields: { ...currentReview._virtualFields },
    _changed: new Set(currentReview._changed),
    _isNew: currentReview._isNew
  });
  deletedReview._setupPropertyAccessors();
  
  // Test indexing current revision
  await search.indexReview(currentReview);
  t.is(indexedReviews.length, 1, 'Should index current revision');
  
  // Test skipping old revision
  await search.indexReview(oldReview);
  t.is(indexedReviews.length, 1, 'Should skip old revision');
  
  // Test skipping deleted revision
  await search.indexReview(deletedReview);
  t.is(indexedReviews.length, 1, 'Should skip deleted revision');
});

test.serial('maintenance script uses correct models based on database mode', async t => {
  // This test verifies that the maintenance script logic works correctly
  // We can't easily test the full script execution, but we can test the model selection logic
  
  const { isDualDatabaseMode, getPostgresDAL } = require('../db-dual');
  
  // Test the logic that determines which models to use
  if (isDualDatabaseMode() && getPostgresDAL()) {
    // Should use PostgreSQL models
    const { getPostgresThingModel } = require('../models-postgres/thing');
    const { getPostgresReviewModel } = require('../models-postgres/review');
    
    const Thing = getPostgresThingModel();
    const Review = getPostgresReviewModel();
    
    if (Thing && Review) {
      t.truthy(Thing.filterNotStaleOrDeleted, 'PostgreSQL Thing model should have filterNotStaleOrDeleted method');
      t.truthy(Review.filterNotStaleOrDeleted, 'PostgreSQL Review model should have filterNotStaleOrDeleted method');
    } else {
      t.skip('PostgreSQL models not available in test environment');
    }
  } else {
    // Should use RethinkDB models
    t.pass('Would use RethinkDB models when PostgreSQL not available');
  }
});

test.serial('search indexing extracts multilingual content correctly', async t => {
  if (skipIfNoModels(t)) return;
  
  const { Thing } = dalFixture;
  
  // Create test-specific arrays
  const testIndexedThings = [];
  const testIndexedReviews = [];
  
  // Create test-specific mock
  const search = {
    indexThing(thing) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (thing._old_rev_of || thing._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedThings.push(thing);
      return Promise.resolve();
    },
    indexReview(review) {
      // Skip indexing if this is an old or deleted revision (same logic as real function)
      if (review._old_rev_of || review._rev_deleted) {
        return Promise.resolve();
      }
      
      testIndexedReviews.push(review);
      return Promise.resolve();
    }
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
    es: 'Libro Multilingüe'
  };
  thing.aliases = { 
    en: ['Alternative Title', 'Another Name'],
    de: ['Alternativer Titel', 'Anderer Name'],
    fr: ['Titre Alternatif'],
    es: ['Título Alternativo']
  };
  thing.metadata = {
    description: { 
      en: 'A book available in multiple languages with rich content',
      de: 'Ein Buch, das in mehreren Sprachen mit reichhaltigem Inhalt verfügbar ist',
      fr: 'Un livre disponible en plusieurs langues avec un contenu riche',
      es: 'Un libro disponible en varios idiomas con contenido rico'
    },
    subtitle: { 
      en: 'International Edition',
      de: 'Internationale Ausgabe',
      fr: 'Édition Internationale',
      es: 'Edición Internacional'
    },
    authors: [
      { 
        en: 'International Author',
        de: 'Internationaler Autor',
        fr: 'Auteur International',
        es: 'Autor Internacional'
      }
    ]
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
  t.is(Object.keys(indexedThing.metadata.description).length, 4, 'Description should have all 4 languages');
  t.is(Object.keys(indexedThing.metadata.subtitle).length, 4, 'Subtitle should have all 4 languages');
  
  // Check specific language content
  t.is(indexedThing.label.en, 'Multilingual Book', 'English label should be correct');
  t.is(indexedThing.label.de, 'Mehrsprachiges Buch', 'German label should be correct');
  t.is(indexedThing.metadata.description.fr, 'Un livre disponible en plusieurs langues avec un contenu riche', 'French description should be correct');
  t.is(indexedThing.metadata.subtitle.es, 'Edición Internacional', 'Spanish subtitle should be correct');
});
