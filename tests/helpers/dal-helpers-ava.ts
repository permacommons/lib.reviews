import { randomUUID } from 'crypto';
import revision from '../../dal/lib/revision.ts';
import types from '../../dal/lib/type.ts';
import type DALFixtureAVA from '../fixtures/dal-fixture-ava.ts';

export interface EnsureUserSeed {
  id: string;
  displayName: string;
  canonicalName: string;
  email: string;
}

type MinimalDALFixture = Pick<DALFixtureAVA, 'getTableName' | 'query'>;

/**
 * AVA-compatible helper functions for DAL testing
 *
 * Provides utilities for testing PostgreSQL DAL with proper isolation:
 * - Test data generators with unique identifiers
 * - Retry logic for concurrent operations
 * - Test isolation verification
 * - Document creation helpers with error handling
 */

/**
 * Get common model definitions for AVA testing
 */
export function getTestModelDefinitionsAVA() {
  return [
    {
      name: 'revisions', // Will be prefixed by fixture
      hasRevisions: true,
      schema: {
        id: types.string().uuid(4),
        title: types.string().max(255),
        content: types.string(),
        ...revision.getSchema()
      },
      options: {}
    },
    {
      name: 'users', // Will be prefixed by fixture
      hasRevisions: false,
      schema: {
        id: types.string().uuid(4),
        display_name: types.string().max(255).required(true),
        canonical_name: types.string().max(255).required(true),
        email: types.string().email().required(true)
      },
      options: {}
    }
  ];
}

/**
 * Get test table definitions for PostgreSQL with AVA isolation
 */
export function getTestTableDefinitionsAVA() {
  return [
    {
      name: 'revisions', // Will be prefixed by fixture
      sql: `
        CREATE TABLE IF NOT EXISTS revisions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title VARCHAR(255),
          content TEXT,
          _rev_user UUID NOT NULL,
          _rev_date TIMESTAMP NOT NULL,
          _rev_id UUID NOT NULL,
          _old_rev_of UUID,
          _rev_deleted BOOLEAN DEFAULT FALSE,
          _rev_tags TEXT[] DEFAULT '{}'
        )
      `,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_revisions_current
         ON revisions (_old_rev_of, _rev_deleted)
         WHERE _old_rev_of IS NULL AND _rev_deleted = false`,
        `CREATE INDEX IF NOT EXISTS idx_revisions_old_rev_of
         ON revisions (_old_rev_of)
         WHERE _old_rev_of IS NOT NULL`
      ]
    },
    {
      name: 'users', // Will be prefixed by fixture
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          display_name VARCHAR(255) NOT NULL,
          canonical_name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE
        )
      `,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_users_canonical_name
         ON users (canonical_name)`,
        `CREATE INDEX IF NOT EXISTS idx_users_email
         ON users (email)`
      ]
    }
  ];
}

/**
 * Generate test user data for AVA tests
 */
export function getTestUserDataAVA(suffix = '') {
  return {
    id: `550e8400-e29b-41d4-a716-44665544000${suffix || '0'}`,
    display_name: `Test User${suffix ? ' ' + suffix : ''}`,
    canonical_name: `testuser${suffix || ''}`,
    email: `test${suffix || ''}@example.com`
  };
}

/**
 * Generate test revision data with proper isolation
 */
export function* getTestRevisionDataGeneratorAVA(userId, prefix = '') {
  let counter = 0;

  while (true) {
    counter++;
    yield {
      title: `${prefix}Test Document ${counter}`,
      content: `This is test content for document ${counter}`,
      _rev_user: userId,
      _rev_date: new Date(),
      _rev_tags: ['test', 'generated', 'ava']
    };
  }
}

/**
 * Create a test document with revisions for AVA tests
 * Includes retry logic to handle concurrent execution issues that can occur
 * when multiple tests try to create documents simultaneously
 */
export async function createTestDocumentWithRevisionsAVA(model, user, revisionCount = 3, titlePrefix = '') {
  // Create first revision with retry logic for concurrency
  let firstRev;
  let retries = 3;

  while (retries > 0) {
    try {
      firstRev = await model.createFirstRevision(user, { tags: ['create', 'test', 'ava'] });
      firstRev.title = `${titlePrefix}Original Title`;
      firstRev.content = 'Original content';
      await firstRev.save();
      break;
    } catch (error) {
      retries--;
      if (retries === 0) throw error;
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  let currentRev = firstRev;

  // Create additional revisions with error handling
  for (let i = 1; i < revisionCount; i++) {
    retries = 3;
    while (retries > 0) {
      try {
        const newRev = await currentRev.newRevision(user, { tags: ['edit', `revision-${i}`, 'ava'] });
        newRev.title = `${titlePrefix}Updated Title ${i}`;
        newRev.content = `Updated content ${i}`;
        await newRev.save();
        currentRev = newRev;
        break;
      } catch (error) {
        retries--;
        if (retries === 0) throw error;
        // Small delay before retry
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  return currentRev;
}

/**
 * Assert that two revision objects have the same core properties (AVA compatible)
 */
export function assertRevisionEqualityAVA(t, actual, expected, message = '') {
  t.is(actual.id, expected.id, `${message} - ID should match`);
  t.is(actual.title, expected.title, `${message} - Title should match`);
  t.is(actual.content, expected.content, `${message} - Content should match`);
  t.is(actual._data._rev_user, expected._data._rev_user, `${message} - Revision user should match`);
}

/**
 * Count total revisions for a document (including old ones) with table prefix
 */
export async function countAllRevisionsAVA(dal, tableName, documentId) {
  const result = await dal.query(
    `SELECT COUNT(*) as count FROM ${tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [documentId]
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Count current (non-stale, non-deleted) revisions with table prefix
 */
export async function countCurrentRevisionsAVA(dal, tableName) {
  const result = await dal.query(
    `SELECT COUNT(*) as count FROM ${tableName}
     WHERE _old_rev_of IS NULL AND _rev_deleted = false`
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Wait for database operations to complete (useful for avoiding race conditions)
 */
export async function waitForDatabaseOperations(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create isolated test data that won't conflict with other tests
 */
export function createIsolatedTestData(testTitle, index = 0) {
  const timestamp = Date.now();
  const testId = `${testTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}_${index}`;

  return {
    id: testId,
    title: `Test Document for ${testTitle} (${index})`,
    content: `Isolated test content for ${testTitle} at ${timestamp}`,
    prefix: `${testId}_`
  };
}

/**
 * Verify test isolation by checking database state
 * Ensures each test starts with a clean database to prevent interference
 */
export async function verifyTestIsolation(t, dal, tableName, expectedCount = 0) {
  const result = await dal.query(`SELECT COUNT(*) as count FROM ${tableName}`);
  const actualCount = parseInt(result.rows[0].count, 10);
  t.is(actualCount, expectedCount, `Test isolation check: expected ${expectedCount} records, found ${actualCount}`);
  return actualCount;
}

export async function ensureUserExists(
  dal: MinimalDALFixture,
  id: string,
  name = 'Test User'
): Promise<EnsureUserSeed> {
  const usersTable = dal.getTableName('users');
  const displayName = name;
  const canonicalName = name.toUpperCase();
  const email = `${id}@example.com`;
  await dal.query(
    `INSERT INTO ${usersTable} (id, display_name, canonical_name, email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, displayName, canonicalName, email]
  );
  return { id, displayName, canonicalName, email };
}

/**
 * Create comprehensive test data for query builder tests
 */
export async function createTestData(dal) {
  // Create test users
  const user1Id = randomUUID();
  const user2Id = randomUUID();

  const user1Data = {
    id: user1Id,
    display_name: 'Test User 1',
    canonical_name: 'testuser1',
    email: 'test1@example.com',
    password: 'hashedpassword1',
    registration_date: new Date(),
    is_trusted: true,
    is_site_moderator: false,
    is_super_user: false
  };

  const user2Data = {
    id: user2Id,
    display_name: 'Test User 2',
    canonical_name: 'testuser2',
    email: 'test2@example.com',
    password: 'hashedpassword2',
    registration_date: new Date(),
    is_trusted: false,
    is_site_moderator: false,
    is_super_user: false
  };

  // Insert users directly into database
  const userTableName = dal.schemaNamespace ? `${dal.schemaNamespace}users` : 'users';
  await dal.query(`
    INSERT INTO ${userTableName} (id, display_name, canonical_name, email, password, registration_date, is_trusted, is_site_moderator, is_super_user)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [user1Data.id, user1Data.display_name, user1Data.canonical_name, user1Data.email, user1Data.password, user1Data.registration_date, user1Data.is_trusted, user1Data.is_site_moderator, user1Data.is_super_user]);

  await dal.query(`
    INSERT INTO ${userTableName} (id, display_name, canonical_name, email, password, registration_date, is_trusted, is_site_moderator, is_super_user)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [user2Data.id, user2Data.display_name, user2Data.canonical_name, user2Data.email, user2Data.password, user2Data.registration_date, user2Data.is_trusted, user2Data.is_site_moderator, user2Data.is_super_user]);

  // Create test things
  const thing1Id = randomUUID();
  const thing2Id = randomUUID();

  const thing1Data = {
    id: thing1Id,
    urls: ['https://example.com/book1'],
    label: { en: 'Test Book 1' },
    aliases: { en: ['Book One', 'First Book'] },
    metadata: {
      description: { en: 'A test book for testing' },
      authors: [{ en: 'Test Author' }]
    },
    original_language: 'en',
    canonical_slug_name: 'test-book-1',
    created_on: new Date(),
    created_by: user1Id,
    _rev_id: randomUUID(),
    _rev_user: user1Id,
    _rev_date: new Date(),
    _rev_tags: ['test'],
    _old_rev_of: null,
    _rev_deleted: false
  };

  const thing2Data = {
    id: thing2Id,
    urls: ['https://example.com/book2'],
    label: { en: 'Test Book 2' },
    aliases: { en: ['Book Two', 'Second Book'] },
    metadata: {
      description: { en: 'Another test book' },
      authors: [{ en: 'Another Author' }]
    },
    original_language: 'en',
    canonical_slug_name: 'test-book-2',
    created_on: new Date(),
    created_by: user2Id,
    _rev_id: randomUUID(),
    _rev_user: user2Id,
    _rev_date: new Date(),
    _rev_tags: ['test'],
    _old_rev_of: null,
    _rev_deleted: false
  };

  // Insert things directly into database
  const thingTableName = dal.schemaNamespace ? `${dal.schemaNamespace}things` : 'things';
  await dal.query(`
    INSERT INTO ${thingTableName} (id, urls, label, aliases, metadata, original_language, canonical_slug_name, created_on, created_by, _rev_id, _rev_user, _rev_date, _rev_tags, _old_rev_of, _rev_deleted)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [thing1Data.id, thing1Data.urls, JSON.stringify(thing1Data.label), JSON.stringify(thing1Data.aliases), JSON.stringify(thing1Data.metadata), thing1Data.original_language, thing1Data.canonical_slug_name, thing1Data.created_on, thing1Data.created_by, thing1Data._rev_id, thing1Data._rev_user, thing1Data._rev_date, thing1Data._rev_tags, thing1Data._old_rev_of, thing1Data._rev_deleted]);

  await dal.query(`
    INSERT INTO ${thingTableName} (id, urls, label, aliases, metadata, original_language, canonical_slug_name, created_on, created_by, _rev_id, _rev_user, _rev_date, _rev_tags, _old_rev_of, _rev_deleted)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [thing2Data.id, thing2Data.urls, JSON.stringify(thing2Data.label), JSON.stringify(thing2Data.aliases), JSON.stringify(thing2Data.metadata), thing2Data.original_language, thing2Data.canonical_slug_name, thing2Data.created_on, thing2Data.created_by, thing2Data._rev_id, thing2Data._rev_user, thing2Data._rev_date, thing2Data._rev_tags, thing2Data._old_rev_of, thing2Data._rev_deleted]);

  // Create test reviews
  const review1Id = randomUUID();
  const review2Id = randomUUID();

  const review1Data = {
    id: review1Id,
    thing_id: thing1Id,
    title: { en: 'Great Book!' },
    text: { en: 'This is a wonderful book that I really enjoyed reading.' },
    html: { en: '<p>This is a wonderful book that I really enjoyed reading.</p>' },
    star_rating: 5,
    created_on: new Date(),
    created_by: user2Id,
    original_language: 'en',
    _rev_id: randomUUID(),
    _rev_user: user2Id,
    _rev_date: new Date(),
    _rev_tags: ['test'],
    _old_rev_of: null,
    _rev_deleted: false
  };

  const review2Data = {
    id: review2Id,
    thing_id: thing2Id,
    title: { en: 'Not Bad' },
    text: { en: 'This book was okay, but not amazing.' },
    html: { en: '<p>This book was okay, but not amazing.</p>' },
    star_rating: 3,
    created_on: new Date(),
    created_by: user1Id,
    original_language: 'en',
    _rev_id: randomUUID(),
    _rev_user: user1Id,
    _rev_date: new Date(),
    _rev_tags: ['test'],
    _old_rev_of: null,
    _rev_deleted: false
  };

  // Insert reviews directly into database
  const reviewTableName = dal.schemaNamespace ? `${dal.schemaNamespace}reviews` : 'reviews';
  await dal.query(`
    INSERT INTO ${reviewTableName} (id, thing_id, title, text, html, star_rating, created_on, created_by, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _old_rev_of, _rev_deleted)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [review1Data.id, review1Data.thing_id, JSON.stringify(review1Data.title), JSON.stringify(review1Data.text), JSON.stringify(review1Data.html), review1Data.star_rating, review1Data.created_on, review1Data.created_by, review1Data.original_language, review1Data._rev_id, review1Data._rev_user, review1Data._rev_date, review1Data._rev_tags, review1Data._old_rev_of, review1Data._rev_deleted]);

  await dal.query(`
    INSERT INTO ${reviewTableName} (id, thing_id, title, text, html, star_rating, created_on, created_by, original_language, _rev_id, _rev_user, _rev_date, _rev_tags, _old_rev_of, _rev_deleted)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [review2Data.id, review2Data.thing_id, JSON.stringify(review2Data.title), JSON.stringify(review2Data.text), JSON.stringify(review2Data.html), review2Data.star_rating, review2Data.created_on, review2Data.created_by, review2Data.original_language, review2Data._rev_id, review2Data._rev_user, review2Data._rev_date, review2Data._rev_tags, review2Data._old_rev_of, review2Data._rev_deleted]);

  return {
    user1: user1Data,
    user2: user2Data,
    thing1: thing1Data,
    thing2: thing2Data,
    review1: review1Data,
    review2: review2Data
  };
}
