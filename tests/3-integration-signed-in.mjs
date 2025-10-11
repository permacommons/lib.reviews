import test from 'ava';
import supertest from 'supertest';
import isUUID from 'is-uuid';
import { createRequire } from 'module';
import { extractCSRF } from './helpers/integration-helpers.mjs';
import { getModels } from './helpers/model-helpers.mjs';

const require = createRequire(import.meta.url);

// Standard env settings
process.env.NODE_ENV = 'development';
// Prevent config from installing file watchers that would leak handles under AVA.
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-3';

const { createDBFixture } = await import('./fixtures/db-fixture.mjs');
const dbFixture = createDBFixture();

// Share cookies and app across tests
let agent, app;

test.before(async() => {
  await dbFixture.bootstrap(getModels());
  // Initialize once so sessions table is created if needed
  const getApp = require('../app');
  app = await getApp();
});

// This test needs to run before all the following. It creates a user and logs
// them in
test.serial('We can register an account via the form (captcha disabled)', async t => {
  agent = supertest.agent(app);
  const registerResponse = await agent.get('/register');
  const csrf = extractCSRF(registerResponse.text);
  if (!csrf)
    return t.fail('Could not obtain CSRF token');

  const postResponse = await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username: 'A friend of many GNUs',
      password: 'toGNUornottoGNU',
    })
    .expect(302)
    .expect('location', '/');

  await agent
    .get(postResponse.headers.location)
    .expect(200)
    .expect(/Thank you for registering a lib.reviews account, A friend of many GNUs!/);

  t.pass();
});

// This may fail if we add more than one review concurrently to the feed
test('We can create and edit a review', async t => {
  const newReviewResponse = await agent.get('/new/review');
  let csrf = extractCSRF(newReviewResponse.text);
  if (!csrf)
    return t.fail('Could not obtain CSRF token');

  const postResponse = await agent
    .post('/new/review')
    .type('form')
    .send({
      _csrf: csrf,
      'review-url': 'http://zombo.com/',
      'review-title': 'The unattainable is unknown',
      'review-text': 'This is a decent enough resource if you want to do anything, although the newsletter is not available yet and it requires Flash. Check out http://html5zombo.com/ as well.',
      'review-rating': 3,
      'review-language': 'en',
      'review-action': 'publish'
    })
    .expect(302);

  const feedResponse = await agent
    .get(postResponse.headers.location)
    .expect(200)
    .expect(/<p>This is a decent enough resource if you want to do anything/)
    .expect(/Written by <a href="\/user\/A_friend_of_many_GNUs">A friend of/);

  const match = feedResponse.text.match(/<a href="(\/review\/.*?\/edit)/);
  if (!match)
    return t.fail('Could not find edit link');

  const editURL = match[1];
  const editResponse = await agent.get(editURL)
    .expect(200)
    .expect(/Editing a review of/)
    .expect(/value="The unattainable is unknown"/);

  csrf = extractCSRF(editResponse.text);

  const editPostResponse = await agent
    .post(editURL)
    .type('form')
    .send({
      _csrf: csrf,
      'review-title': 'The unattainable is still unknown',
      'review-text': 'I just checked, and I can still do anything on Zombo.com.',
      'review-rating': '3',
      'review-language': 'en',
      'review-action': 'publish'
    })
    .expect(302);

  await agent
    .get(editPostResponse.headers.location)
    .expect(200)
    .expect(/I just checked/)
    .expect(/Written by <a href="\/user\/A_friend_of_many_GNUs">A friend of/);

  t.pass();
});

test('We can create a new team', async t => {
  await agent.get('/new/team')
    .expect(403)
    .expect(/do not have permission/);

  const user = await dbFixture.models.User.findByURLName('A_friend_of_many_GNUs', { withPassword: true });
  t.true(isUUID.v4(user.id), 'Previously created user could be found through model');

  // Give user permission needed to create team
  user.isTrusted = true;
  await user.save();
  const newTeamResponse = await agent.get('/new/team')
    .expect(200)
    .expect(/Rules for joining/);

  const csrf = extractCSRF(newTeamResponse.text);
  if (!csrf)
    return t.fail('Could not obtain CSRF token');

  const newTeamPostResponse = await agent
    .post('/new/team')
    .type('form')
    .send({
      _csrf: csrf,
      'team-name': 'Kale Alliance',
      'team-motto': 'Get Your Kale On',
      'team-description': 'We seek all the kale. Then we must eat it.',
      'team-rules': 'No leftovers.',
      'team-only-mods-can-blog': true,
      'team-language': 'en',
      'team-action': 'publish'
    })
    .expect(302);

  await agent
    .get(newTeamPostResponse.headers.location)
    .expect(200)
    .expect(/Team: Kale Alliance/);

  t.pass();
});

test.after.always(async t => {
  if (agent && typeof agent.close === 'function') {
    await new Promise(resolve => agent.close(resolve));
    agent = null;
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
});
