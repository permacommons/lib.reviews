import test from 'ava';
import supertest from 'supertest';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
const loadAppModule = () => import('../app.mjs');

// Mock search before loading any modules that depend on it (e.g. bootstrap/dal).
mockSearch();

const { setupPostgresTest } = await import('./helpers/setup-postgres-test.mjs');

setupPostgresTest(test, {
  schemaNamespace: 'csrf_protection'
});

test.before(async t => {
  mockSearch();
});

test.beforeEach(async t => {
  const { default: getApp, resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function')
    await resetAppForTesting();
  t.context.app = await getApp();
  t.context.agent = supertest.agent(t.context.app);
});

test('POST to /signin without CSRF token is rejected with 403', async t => {
  await t.context.agent
    .post('/signin')
    .type('form')
    .send({
      username: 'testuser',
      password: 'testpassword'
      // Deliberately omitting _csrf token
    })
    .expect(403);

  t.pass();
});

test('POST to /signin with invalid CSRF token is rejected with 403', async t => {
  await t.context.agent
    .post('/signin')
    .type('form')
    .send({
      _csrf: 'invalid-token-that-does-not-match',
      username: 'testuser',
      password: 'testpassword'
    })
    .expect(403);

  t.pass();
});

test('POST to /signin with valid CSRF token is accepted (even if credentials are wrong)', async t => {
  // Get a valid CSRF token from the signin page
  const signinResponse = await t.context.agent.get('/signin');
  const csrf = extractCSRF(signinResponse.text);

  if (!csrf) return t.fail('Could not obtain CSRF token');

  // POST with the valid token but wrong credentials
  // Should NOT get 403 (CSRF error), but should fail authentication
  const response = await t.context.agent
    .post('/signin')
    .type('form')
    .send({
      _csrf: csrf,
      username: 'nonexistent',
      password: 'wrongpassword'
    });

  // Should not be 403 (CSRF error)
  t.not(response.status, 403, 'Valid CSRF token should not result in 403');

  // Should be either 302 (redirect back with error) or 401/200 with error message
  t.true(
    response.status === 302 || response.status === 401 || response.status === 200,
    `Expected redirect or auth error, got ${response.status}`
  );

  t.pass();
});

test('POST to /register without CSRF token is rejected with 403', async t => {
  await t.context.agent
    .post('/register')
    .type('form')
    .send({
      username: 'newuser',
      password: 'password123'
      // Deliberately omitting _csrf token
    })
    .expect(403);

  t.pass();
});

test('POST to /actions/change-language without CSRF token is rejected with 403', async t => {
  await t.context.agent
    .post('/actions/change-language')
    .type('form')
    .send({
      lang: 'de'
      // Deliberately omitting _csrf token
    })
    .expect(403);

  t.pass();
});

test.serial('Authenticated POST to /signout without CSRF token is rejected with 403', async t => {
  const agent = t.context.agent;
  const username = `CSRFTestUser-${Date.now()}`;

  // Register and login a user (with valid CSRF)
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  // Try to sign out without CSRF token
  await agent
    .post('/signout')
    .type('form')
    .send({
      // Deliberately omitting _csrf token
    })
    .expect(403);

  t.pass();
});

test.serial('Authenticated POST to create review without CSRF token is rejected with 403', async t => {
  const agent = t.context.agent;
  const username = `CSRFTestUser2-${Date.now()}`;

  // Register and login a user (with valid CSRF)
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  // Try to create a review without CSRF token
  await agent
    .post('/new/review')
    .type('form')
    .send({
      'review-url': 'https://example.com',
      'review-label': 'Test Product',
      'review-title': 'Test Review',
      'review-text': 'This is a test review'
      // Deliberately omitting _csrf token
    })
    .expect(403);

  t.pass();
});

test.serial('File upload stage 2 (metadata) without CSRF token is rejected with 403', async t => {
  const agent = t.context.agent;

  // Test 1: POST without CSRF token should fail with 403
  const responseWithoutCsrf = await agent
    .post('/test-thing/upload')
    .type('form')
    .send({
      // Deliberately omitting _csrf token
      'upload-language': 'en',
      'upload-fakeid': '1',
      'upload-fakeid-description': 'Test description',
      'upload-fakeid-by': 'uploader'
    });

  t.is(responseWithoutCsrf.status, 403, 'Request without CSRF should return 403');

  // Test 2: POST with valid CSRF token should pass CSRF check
  // (will fail for other reasons like missing thing, but NOT 403 for CSRF)
  const pageResponse = await agent.get('/');
  const validCsrf = extractCSRF(pageResponse.text);

  if (!validCsrf) return t.fail('Could not obtain valid CSRF token');

  const responseWithCsrf = await agent
    .post('/test-thing/upload')
    .type('form')
    .send({
      _csrf: validCsrf,
      'upload-language': 'en',
      'upload-fakeid': '1',
      'upload-fakeid-description': 'Test description',
      'upload-fakeid-by': 'uploader'
    });

  // Should NOT be 403 (CSRF passed, will fail for other reasons like 404 for missing thing)
  t.not(responseWithCsrf.status, 403, 'Request with valid CSRF should not return 403');

  t.pass();
});

test.after.always(async t => {
  if (t.context.agent && typeof t.context.agent.close === 'function') {
    await new Promise(resolve => t.context.agent.close(resolve));
    t.context.agent = null;
  }
  const { resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function')
    await resetAppForTesting();
  unmockSearch();
  if (t.context.app && t.context.app.locals.dal) {
    await t.context.app.locals.dal.cleanup();
  }
});
