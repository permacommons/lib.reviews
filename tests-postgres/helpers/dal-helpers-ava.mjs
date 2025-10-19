import { createRequire } from 'module';

const require = createRequire(import.meta.url);

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
  const Type = require('../../dal/lib/type');
  const revision = require('../../dal/lib/revision');
  
  return [
    {
      name: 'revisions', // Will be prefixed by fixture
      hasRevisions: true,
      schema: {
        id: Type.string().uuid(4),
        title: Type.string().max(255),
        content: Type.string(),
        ...revision.getSchema()
      },
      options: {}
    },
    {
      name: 'users', // Will be prefixed by fixture
      hasRevisions: false,
      schema: {
        id: Type.string().uuid(4),
        display_name: Type.string().max(255).required(true),
        canonical_name: Type.string().max(255).required(true),
        email: Type.string().email().required(true)
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