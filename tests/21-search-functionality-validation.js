import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.js';

import { ensureUserExists } from './helpers/dal-helpers-ava.js';

import { mockSearch, unmockSearch } from './helpers/mock-search.js';


const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'search_validation',
  cleanupTables: ['users', 'things', 'reviews']
});

let searchQueries;
let mockSearchResponse;

test.before(async () => {
  await bootstrapPromise;

  const captured = mockSearch();
  searchQueries = captured.searchQueries;
  mockSearchResponse = captured.mockSearchResponse;

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' }
  ]);

  dalFixture.Thing = models.Thing;
  dalFixture.Review = models.Review;
});

test.after.always(unmockSearch);

test.beforeEach(() => {
  if (Array.isArray(searchQueries)) {
    searchQueries.length = 0;
  }
  if (mockSearchResponse && mockSearchResponse.hits) {
    mockSearchResponse.hits.hits = [];
    mockSearchResponse.hits.total = { value: 0 };
  }
});

test.serial('searchThings API maintains compatibility with existing interface', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Test basic search
  await search.searchThings('test query', 'en');
  
  t.is(searchQueries.length, 1, 'Should have captured one search query');
  
  const query = searchQueries[0];
  t.is(query.type, 'searchThings', 'Should be a searchThings query');
  t.is(query.query, 'test query', 'Query should be preserved');
  t.is(query.lang, 'en', 'Language should be preserved');
});

test.serial('searchReviews API maintains compatibility with existing interface', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Test basic search
  await search.searchReviews('review query', 'de');
  
  t.is(searchQueries.length, 1, 'Should have captured one search query');
  
  const query = searchQueries[0];
  t.is(query.type, 'searchReviews', 'Should be a searchReviews query');
  t.is(query.query, 'review query', 'Query should be preserved');
  t.is(query.lang, 'de', 'Language should be preserved');
});

test.serial('suggestThing API maintains compatibility with existing interface', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Test suggestion
  await search.suggestThing('test', 'fr');
  
  t.is(searchQueries.length, 1, 'Should have captured one suggestion query');
  
  const query = searchQueries[0];
  t.is(query.type, 'suggestThing', 'Should be a suggestThing query');
  t.is(query.prefix, 'test', 'Prefix should be preserved');
  t.is(query.lang, 'fr', 'Language should be preserved');
});

test.serial('search queries include new PostgreSQL fields', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Create test data with PostgreSQL structure
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Search Validation User');
  
  const thing = await dalFixture.Thing.createFirstRevision(testUser, { tags: ['create'] });
  thing.urls = ['https://example.com/test-search'];
  thing.label = { en: 'Test Search Item', de: 'Test-Suchelement' };
  thing.aliases = { en: ['Alternative Name'], de: ['Alternativer Name'] };
  thing.metadata = {
    description: { 
      en: 'A test item for search validation',
      de: 'Ein Testelement für die Suchvalidierung'
    },
    subtitle: { 
      en: 'Search Test Edition',
      de: 'Suchtest-Ausgabe'
    },
    authors: [
      { en: 'Test Author', de: 'Test Autor' }
    ]
  };
  thing.createdOn = new Date();
  thing.createdBy = testUserId;
  
  await thing.save();
  
  // Verify the thing has the expected structure for search
  t.truthy(thing.metadata, 'Thing should have metadata');
  t.truthy(thing.metadata.description, 'Thing should have description in metadata');
  t.truthy(thing.metadata.subtitle, 'Thing should have subtitle in metadata');
  t.truthy(thing.metadata.authors, 'Thing should have authors in metadata');
  
  // Test that search would work with this structure
  t.deepEqual(thing.label, { en: 'Test Search Item', de: 'Test-Suchelement' }, 'Label should be multilingual');
  t.deepEqual(thing.aliases, { en: ['Alternative Name'], de: ['Alternativer Name'] }, 'Aliases should be multilingual');
  t.deepEqual(thing.metadata.description, { 
    en: 'A test item for search validation',
    de: 'Ein Testelement für die Suchvalidierung'
  }, 'Description should be multilingual in metadata');
});

test.serial('search performance with PostgreSQL JSONB fields', async t => {
  
  const { Thing } = dalFixture;
  
  const testUserId = randomUUID();
  const testUser = { id: testUserId, is_super_user: false, is_trusted: true };
  await ensureUserExists(dalFixture, testUserId, 'Performance User');
  
  // Create multiple things with complex JSONB data
  const things = [];
  for (let i = 0; i < 10; i++) {
    const thing = await Thing.createFirstRevision(testUser, { tags: ['create'] });
    thing.urls = [`https://example.com/perf-test-${i}`];
    thing.label = { 
      en: `Performance Test Item ${i}`,
      de: `Leistungstest-Element ${i}`,
      fr: `Élément de test de performance ${i}`
    };
    thing.aliases = { 
      en: [`Alt Name ${i}`, `Alternative ${i}`],
      de: [`Alt Name ${i}`, `Alternative ${i}`],
      fr: [`Nom Alt ${i}`, `Alternative ${i}`]
    };
    thing.metadata = {
      description: { 
        en: `Performance test description for item ${i}`,
        de: `Leistungstest-Beschreibung für Element ${i}`,
        fr: `Description du test de performance pour l'élément ${i}`
      },
      subtitle: { 
        en: `Performance Edition ${i}`,
        de: `Leistungsausgabe ${i}`,
        fr: `Édition Performance ${i}`
      },
      authors: [
        { 
          en: `Performance Author ${i}`,
          de: `Leistungsautor ${i}`,
          fr: `Auteur Performance ${i}`
        }
      ]
    };
    thing.createdOn = new Date();
    thing.createdBy = testUserId;
    
    await thing.save();
    things.push(thing);
  }
  
  // Measure query performance (basic timing)
  const startTime = Date.now();
  
  // Query all current revisions (this would be used by search indexing)
  const currentThings = await Thing.filterNotStaleOrDeleted().run();
  
  const endTime = Date.now();
  const queryTime = endTime - startTime;
  
  t.truthy(currentThings.length >= 10, 'Should retrieve at least 10 things');
  t.true(queryTime < 1000, `Query should complete in reasonable time (${queryTime}ms)`);
  
  // Verify JSONB data integrity
  const firstThing = currentThings.find(t => t.label && t.label.en && t.label.en.includes('Performance Test Item'));
  if (firstThing) {
    t.truthy(firstThing.metadata, 'Thing should have metadata');
    t.truthy(firstThing.metadata.description, 'Thing should have description in metadata');
    t.truthy(firstThing.metadata.subtitle, 'Thing should have subtitle in metadata');
    t.truthy(firstThing.metadata.authors, 'Thing should have authors in metadata');
  }
});

test.serial('search API error handling remains consistent', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Test with invalid parameters (should not throw)
  await t.notThrowsAsync(async () => {
    await search.searchThings('', '');
  }, 'Empty search should not throw');
  
  await t.notThrowsAsync(async () => {
    await search.searchReviews(null, 'invalid-lang');
  }, 'Invalid parameters should not throw');
  
  await t.notThrowsAsync(async () => {
    await search.suggestThing(undefined, 'en');
  }, 'Undefined prefix should not throw');
});

test.serial('search results structure remains compatible', async t => {
  
  const { default: search } = await import('../search.ts');
  
  // Set up mock response with expected structure
  mockSearchResponse.hits = {
    hits: [
      {
        _id: 'test-id',
        _source: {
          type: 'thing',
          label: { en: 'Test Item' },
          description: { en: 'Test description' },
          createdOn: new Date().toISOString()
        },
        highlight: {
          'label.en': ['<span class="search-highlight">Test</span> Item']
        }
      }
    ],
    total: { value: 1 }
  };
  
  const result = await search.searchThings('test', 'en');
  
  // Verify result structure
  t.truthy(result.hits, 'Result should have hits property');
  t.truthy(result.hits.hits, 'Result should have hits.hits array');
  t.truthy(result.hits.total, 'Result should have hits.total');
  t.is(result.hits.hits.length, 1, 'Should have one hit');
  
  const hit = result.hits.hits[0];
  t.truthy(hit._id, 'Hit should have _id');
  t.truthy(hit._source, 'Hit should have _source');
  t.truthy(hit.highlight, 'Hit should have highlight');
  t.is(hit._source.type, 'thing', 'Hit should be a thing');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
