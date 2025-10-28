import test from 'ava';
import supertest from 'supertest';
import isUUID from 'is-uuid';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const require = createRequire(import.meta.url);

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

let User, Team, TeamJoinRequest;
let app;

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' },
    { key: 'team_slugs', alias: 'TeamSlug' },
    { key: 'team_join_requests', alias: 'TeamJoinRequest' }
  ]);

  User = models.User;
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
  if (!User || !app) {
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
