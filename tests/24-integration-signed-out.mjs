import test from 'ava';
import supertest from 'supertest';
import { extractCSRF } from './helpers/integration-helpers.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
const loadAppModule = () => import('../app.mjs');

// Mock search before loading any modules that depend on it (e.g. bootstrap/dal).
mockSearch();

const { setupPostgresTest } = await import('./helpers/setup-postgres-test.mjs');

const routeTests = [
  { path: '/', status: 200, regex: /Welcome/ },
  { path: '/signin', status: 200, regex: /Sign in/ },
  { path: '/register', status: 200, regex: /Register/ },
  { path: '/teams', status: 200, regex: /Browse teams/ },
  { path: '/feed', status: 200, regex: /Latest reviews/ },
  { path: '/terms', status: 200, regex: /Terms of use/ },
  { path: '/static/downloads', status: 200, regex: /Downloads/ },
  { path: '/review/+not+a+review+', status: 404, regex: /Review address invalid/ },
  { path: '/team/+not+a+team+', status: 404, regex: /Team not found/ },
  { path: '/+not+a+thing+', status: 404, regex: /Thing not found/ }
];

setupPostgresTest(test, {
  schemaNamespace: 'integration_signed_out'
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

for (const route of routeTests) {
  test(`${route.path} returns ${route.status} and body containing ${route.regex}`, async t => {
    t.context.app.locals.test = 'route test';
    await t.context.agent
      .get(route.path)
      .expect(route.status)
      .expect(route.regex);
    t.pass();
  });
}

test('Changing to German returns German strings', async t => {
  const mainPageResponse = await t.context.agent.get('/');
  const csrf = extractCSRF(mainPageResponse.text);
  if (!csrf) return t.fail('Could not obtain CSRF token');

  const postResponse = await t.context.agent
    .post('/actions/change-language')
    .type('form')
    .send({
      _csrf: csrf,
      lang: 'de' // Change language
    })
    .expect(302)
    .expect('location', '/');

  await t.context.agent
    .get(postResponse.headers.location)
    .expect(200)
    .expect(/respektiert deine Freiheit/); // String in footer

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
