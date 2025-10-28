import test from 'ava';
import supertest from 'supertest';
import isUUID from 'is-uuid';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const uploadsDir = path.join(projectRoot, 'static/uploads');

mockSearch();

const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
  schemaNamespace: 'integration_signed_in',
  cleanupTables: [
    'team_join_requests',
    'review_teams',
    'team_moderators',
    'team_members',
    'reviews',
    'teams',
    'things',
    'files',
    'users'
  ]
});

let User, File, Team, TeamJoinRequest;
let app;

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'files', alias: 'File' },
    { key: 'teams', alias: 'Team' },
    { key: 'team_slugs', alias: 'TeamSlug' },
    { key: 'team_join_requests', alias: 'TeamJoinRequest' }
  ]);

  User = models.User;
  File = models.File;
  Team = models.Team;
  TeamJoinRequest = models.TeamJoinRequest;

  const config = require('config');
  await fs.mkdir(config.uploadTempDir, { recursive: true });

  Reflect.deleteProperty(require.cache, require.resolve('../app'));
  const getApp = require('../app');
  app = await getApp();
});

async function skipIfNoModels(t) {
  if (await skipIfUnavailable(t)) return true;
  if (!User || !File || !app) {
    t.log('Skipping - PostgreSQL DAL not available');
    t.pass('Skipping - PostgreSQL DAL not available');
    return true;
  }
  return false;
}

test.serial('We can register an account via the form (captcha disabled)', async t => {
  if (await skipIfNoModels(t)) return;

  const agent = supertest.agent(app);
  const username = 'A friend of many GNUs';
  const { landingResponse } = await registerTestUser(agent, {
    username,
    password: 'toGNUornottoGNU'
  });

  t.truthy(landingResponse);
  t.regex(landingResponse.text, /Thank you for registering a lib\.reviews account, A friend of many GNUs!/);
  t.pass();
});

test.serial('We can create and edit a review', async t => {
  if (await skipIfNoModels(t)) return;

  const agent = supertest.agent(app);
  const username = `ReviewCreator-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const newReviewResponse = await agent.get('/new/review');
  let csrf = extractCSRF(newReviewResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token');
  }

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
    .expect(new RegExp(`Written by <a href="/user/${username.replace(/ /g, '_')}">`));

  const match = feedResponse.text.match(/<a href="(\/review\/.*?\/edit)/);
  if (!match) {
    return t.fail('Could not find edit link');
  }

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
    .expect(new RegExp(`Written by <a href="/user/${username.replace(/ /g, '_')}">`));

  t.pass();
});

test.serial('We can create a new team', async t => {
  if (await skipIfNoModels(t)) return;

  const agent = supertest.agent(app);
  const username = `TeamCreator-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  await agent.get('/new/team')
    .expect(403)
    .expect(/do not have permission/);

  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName, { withPassword: true });
  t.true(isUUID.v4(user.id), 'Previously created user could be found through model');

  user.isTrusted = true;
  await user.save();

  const newTeamResponse = await agent.get('/new/team')
    .expect(200)
    .expect(/Rules for joining/);

  const csrf = extractCSRF(newTeamResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token');
  }

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

test.serial('We can upload media via the API', async t => {
  if (await skipIfNoModels(t)) return;

  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64'
  );

  const uploadAgent = supertest.agent(app);
  const username = `Uploader ${Date.now()}`;
  await registerTestUser(uploadAgent, {
    username,
    password: 'uploadRocks!'
  });

  const urlName = username.replace(/ /g, '_');
  const uploader = await User.findByURLName(urlName, { withPassword: true });
  uploader.isTrusted = true;
  await uploader.save();

  let uploadedPath;
  let savedFile;

  try {
    const response = await uploadAgent
      .post('/api/actions/upload')
      .set('x-requested-with', 'XMLHttpRequest')
      .field('description', 'Tiny PNG')
      .field('license', 'cc-by')
      .field('ownwork', 'true')
      .field('language', 'en')
      .attach('files', pngBuffer, {
        filename: 'tiny.png',
        contentType: 'image/png'
      });

    t.is(response.status, 200, `Upload failed: ${response.status} ${response.text}`);
    t.true(/json/.test(response.headers['content-type']), 'Response should be JSON');

    const body = Object.keys(response.body || {}).length ? response.body : JSON.parse(response.text);

    t.is(body.message, 'Upload successful.');
    t.deepEqual(body.errors, []);
    t.true(Array.isArray(body.uploads));
    t.is(body.uploads.length, 1);

    const uploaded = body.uploads[0];
    t.truthy(uploaded.fileID);
    t.is(uploaded.originalName, 'tiny.png');
    t.is(uploaded.license, 'cc-by');
    t.deepEqual(uploaded.description, { en: 'Tiny PNG' });

    uploadedPath = path.join(uploadsDir, uploaded.uploadedFileName);
    const stats = await fs.stat(uploadedPath);
    t.true(stats.size > 0, 'Uploaded file should exist on disk.');

    savedFile = await File.get(uploaded.fileID);
    t.true(savedFile.completed, 'Saved file metadata should be marked completed.');
    t.is(savedFile.mimeType, 'image/png');
    t.is(savedFile.license, 'cc-by');
    t.is(savedFile.uploadedBy, uploader.id);
    t.deepEqual(savedFile.description, { en: 'Tiny PNG' });
  } finally {
    if (savedFile) {
      await savedFile.deleteAllRevisions().catch(() => {});
    }
    if (uploadedPath) {
      await fs.unlink(uploadedPath).catch(() => {});
    }
  }
});

test.serial('API upload rejects files with unrecognized signature', async t => {
  if (await skipIfNoModels(t)) return;

  const uploadAgent = supertest.agent(app);
  const username = `Uploader ${Date.now()} invalid`;
  await registerTestUser(uploadAgent, {
    username,
    password: 'uploadFails!'
  });

  const urlName = username.replace(/ /g, '_');
  const uploader = await User.findByURLName(urlName, { withPassword: true });
  uploader.isTrusted = true;
  await uploader.save();

  const bogusBuffer = Buffer.from('definitely not an image');

  const response = await uploadAgent
    .post('/api/actions/upload')
    .set('x-requested-with', 'XMLHttpRequest')
    .field('description', 'Bogus file')
    .field('license', 'cc-by')
    .field('ownwork', 'true')
    .field('language', 'en')
    .attach('files', bogusBuffer, {
      filename: 'fake.png',
      contentType: 'image/png'
    });

  t.is(response.status, 400, `Expected upload to be rejected, got ${response.status}`);

  const body = Object.keys(response.body || {}).length ? response.body : JSON.parse(response.text);
  t.is(body.message, 'Could not perform action.');
  t.true(Array.isArray(body.errors) && body.errors.length > 0, 'Expected error details in response');

  const [errorDetail] = body.errors;
  t.truthy(errorDetail.internalMessage);
  t.true(
    (errorDetail.displayMessage || '').includes('did not recognize the file type'),
    `Unexpected display message: ${errorDetail.displayMessage}`
  );

  const savedFiles = await File.filter({ uploadedBy: uploader.id });
  t.is(savedFiles.length, 0, 'No file records should be persisted for rejected uploads');
});

test.serial('Team join request workflow: join, approve, leave, rejoin', async t => {
  if (await skipIfNoModels(t)) return;

  // Create moderator who will manage the team
  const modAgent = supertest.agent(app);
  const modUsername = `TeamMod-${Date.now()}`;
  await registerTestUser(modAgent, {
    username: modUsername,
    password: 'modpass123'
  });

  const modUrlName = modUsername.replace(/ /g, '_');
  const moderator = await User.findByURLName(modUrlName, { withPassword: true });
  moderator.isTrusted = true;
  await moderator.save();

  // Create a team with moderator approval required
  const newTeamResponse = await modAgent.get('/new/team').expect(200);
  const csrf = extractCSRF(newTeamResponse.text);

  const teamPostResponse = await modAgent
    .post('/new/team')
    .type('form')
    .send({
      _csrf: csrf,
      'team-name': `Test Team ${Date.now()}`,
      'team-motto': 'Testing join requests',
      'team-description': 'A team for testing',
      'team-rules': 'Be nice',
      'team-mod-approval-to-join': true,
      'team-language': 'en',
      'team-action': 'publish'
    })
    .expect(302);

  const teamURL = teamPostResponse.headers.location;
  t.regex(teamURL, /^\/team\//);

  // Create a regular user who will request to join
  const userAgent = supertest.agent(app);
  const username = `TeamJoiner-${Date.now()}`;
  await registerTestUser(userAgent, {
    username: username,
    password: 'userpass123'
  });

  const userUrlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(userUrlName, { withPassword: true });

  // User visits team page and requests to join
  const teamPageResponse = await userAgent.get(teamURL).expect(200);
  const joinCsrf = extractCSRF(teamPageResponse.text);

  await userAgent
    .post(`${teamURL}/join`)
    .type('form')
    .send({
      _csrf: joinCsrf,
      'join-request-message': 'I would like to join',
      'agree-to-rules': 'on'
    })
    .expect(302);

  // Verify join request was created with status=pending
  let joinRequests = await TeamJoinRequest.filter({ userID: user.id });
  t.is(joinRequests.length, 1);
  t.is(joinRequests[0].status, 'pending');
  t.is(joinRequests[0].requestMessage, 'I would like to join');

  // User should see "application received" message
  const afterJoinResponse = await userAgent.get(teamURL).expect(200);
  t.regex(afterJoinResponse.text, /team has been received/i);

  // Moderator approves the request
  const manageURL = `${teamURL}/manage-requests`;
  const manageResponse = await modAgent.get(manageURL).expect(200);
  t.regex(manageResponse.text, /I would like to join/);

  const manageCsrf = extractCSRF(manageResponse.text);
  const requestId = joinRequests[0].id;

  await modAgent
    .post(manageURL)
    .type('form')
    .send({
      _csrf: manageCsrf,
      [`action-${requestId}`]: 'accept',
      'manage-requests-action': 'process-requests'
    })
    .expect(302);

  // Verify request status changed to approved
  joinRequests = await TeamJoinRequest.filter({ userID: user.id });
  t.is(joinRequests[0].status, 'approved');

  // User should now be a member
  const team = await Team.getWithData(joinRequests[0].teamID, { withMembers: true });
  t.true(team.members.some(m => m.id === user.id));

  // User leaves the team
  const teamPageAfterApproval = await userAgent.get(teamURL).expect(200);
  const leaveCsrf = extractCSRF(teamPageAfterApproval.text);

  await userAgent
    .post(`${teamURL}/leave`)
    .type('form')
    .send({ _csrf: leaveCsrf })
    .expect(302);

  // Verify request status changed to withdrawn
  joinRequests = await TeamJoinRequest.filter({ userID: user.id });
  t.is(joinRequests[0].status, 'withdrawn');

  // User is no longer a member
  const teamAfterLeave = await Team.getWithData(joinRequests[0].teamID, { withMembers: true });
  t.false(teamAfterLeave.members.some(m => m.id === user.id));

  // User can rejoin - should reuse existing request
  const rejoinPageResponse = await userAgent.get(teamURL).expect(200);
  t.notRegex(rejoinPageResponse.text, /team has been received/i, 'Should not show withdrawn request message');

  const rejoinCsrf = extractCSRF(rejoinPageResponse.text);

  await userAgent
    .post(`${teamURL}/join`)
    .type('form')
    .send({
      _csrf: rejoinCsrf,
      'join-request-message': 'I would like to rejoin',
      'agree-to-rules': 'on'
    })
    .expect(302);

  // Verify same request was updated (not a new one created)
  joinRequests = await TeamJoinRequest.filter({ userID: user.id });
  t.is(joinRequests.length, 1, 'Should still only have one request record');
  t.is(joinRequests[0].status, 'pending', 'Status should be back to pending');
  t.is(joinRequests[0].requestMessage, 'I would like to rejoin', 'Message should be updated');

  t.pass();
});

test.after.always(async () => {
  unmockSearch();
  await dalFixture.cleanup();
});
