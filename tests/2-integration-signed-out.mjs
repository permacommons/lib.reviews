import test from 'ava';
import supertest from 'supertest';
import { createRequire } from 'module';
import { extractCSRF } from './helpers/integration-helpers.mjs';
import { getModels } from './helpers/model-helpers.mjs';

const require = createRequire(import.meta.url);

// Standard env settings
process.env.NODE_ENV = 'development';
// Prevent config from installing file watchers that would leak handles under AVA.
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-2';

const { createDBFixture } = await import('./fixtures/db-fixture.mjs');
const dbFixture = createDBFixture();
const search = require('../search');

const routeTests = [{
    path: '/',
    status: 200,
    regex: /Welcome/
  },
  {
    path: '/signin',
    status: 200,
    regex: /Sign in/
  },
  {
    path: '/register',
    status: 200,
    regex: /Register/
  },
  {
    path: '/teams',
    status: 200,
    regex: /Browse teams/
  },
  {
    path: '/feed',
    status: 200,
    regex: /Latest reviews/
  },
  {
    path: '/terms',
    status: 200,
    regex: /Terms of use/
  },
  {
    path: '/static/downloads',
    status: 200,
    regex: /Downloads/
  },
  {
    path: '/review/+not+a+review+',
    status: 404,
    regex: /Review not found/
  },
  {
    path: '/team/+not+a+team+',
    status: 404,
    regex: /Team not found/
  },
  {
    path: '/+not+a+thing+',
    status: 404,
    regex: /Thing not found/
  }
];

test.before(async() => {
  await dbFixture.bootstrap(getModels());
  // Initialize once so sessions table is created if needed
  const getApp = require('../app');
  await getApp();
});

test.beforeEach(async t => {
  // Ensure we initialize from scratch
  Reflect.deleteProperty(require.cache, require.resolve('../app'));
  const getApp = require('../app');
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
  if (!csrf)
    return t.fail('Could not obtain CSRF token');

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
  await dbFixture.cleanup();
  // AVA treats lingering handles as failures, so explicitly close anything the test touched.
  const activeHandles = process._getActiveHandles();
  for (const handle of activeHandles) {
    const name = handle && handle.constructor ? handle.constructor.name : undefined;
    if (name === 'FSWatcher' && typeof handle.close === 'function')
      handle.close();
    if (name === 'Socket' && typeof handle.destroy === 'function')
      handle.destroy();
  }
  if (search && typeof search.close === 'function')
    search.close();
});
