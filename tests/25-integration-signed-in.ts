import { randomUUID } from 'node:crypto';
import test from 'ava';
import config from 'config';
import { promises as fs } from 'fs';
import isUUID from 'is-uuid';
import supertest from 'supertest';
import { setupAdapterApiMocks, teardownAdapterApiMocks } from './helpers/adapter-api-mocks.ts';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const loadAppModule = () => import('../app.ts');

mockSearch();

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'integration_signed_in',
  cleanupTables: [
    'team_join_requests',
    'review_teams',
    'team_moderators',
    'team_members',
    'blog_posts',
    'reviews',
    'teams',
    'things',
    'files',
    'users',
    'user_metas',
  ],
});

let User, Team, TeamJoinRequest, Review, Thing, BlogPost, UserMeta;
let app;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' },
    { key: 'team_slugs', alias: 'TeamSlug' },
    { key: 'team_join_requests', alias: 'TeamJoinRequest' },
    { key: 'reviews', alias: 'Review' },
    { key: 'things', alias: 'Thing' },
    { key: 'blog_posts', alias: 'BlogPost' },
    { key: 'user_metas', alias: 'UserMeta' },
  ]);

  User = models.User;
  Team = models.Team;
  TeamJoinRequest = models.TeamJoinRequest;
  Review = models.Review;
  Thing = models.Thing;
  BlogPost = models.BlogPost;
  UserMeta = models.UserMeta;

  await fs.mkdir(config.uploadTempDir, { recursive: true });

  const { default: getApp, resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  app = await getApp();
});

test.serial('We can register an account via the form (captcha disabled)', async t => {
  const agent = supertest.agent(app);
  const username = 'A friend of many GNUs';
  const { landingResponse } = await registerTestUser(agent, {
    username,
    password: 'toGNUornottoGNU',
  });

  t.truthy(landingResponse);
  t.regex(
    landingResponse.text,
    /Thank you for registering a lib\.reviews account, A friend of many GNUs!/
  );
  t.pass();
});

test.serial('We can create and edit a review', async t => {
  const agent = supertest.agent(app);
  const username = `ReviewCreator-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
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
      'review-text':
        'This is a decent enough resource if you want to do anything, although the newsletter is not available yet and it requires Flash. Check out http://html5zombo.com/ as well.',
      'review-rating': 3,
      'review-language': 'en',
      'review-action': 'publish',
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
  const editResponse = await agent
    .get(editURL)
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
      'review-action': 'publish',
    })
    .expect(302);

  await agent
    .get(editPostResponse.headers.location)
    .expect(200)
    .expect(/I just checked/)
    .expect(new RegExp(`Written by <a href="/user/${username.replace(/ /g, '_')}">`));

  t.pass();
});

test.serial('We can edit a thing description', async t => {
  const agent = supertest.agent(app);
  const username = `ThingEditor-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  // Make user trusted so they can edit things
  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName);
  user.isTrusted = true;
  await user.save();

  // Create a review first (which creates a thing)
  const newReviewResponse = await agent
    .get('/new/review')
    .expect(200)
    .expect(/New review/);

  let csrf = extractCSRF(newReviewResponse.text);

  const reviewPostResponse = await agent
    .post('/new/review')
    .type('form')
    .send({
      _csrf: csrf,
      'review-url': 'https://example.com/test-thing',
      'review-title': 'Test Thing Review',
      'review-text': 'This is a test review for description editing.',
      'review-rating': '4',
      'review-language': 'en',
      'review-action': 'publish',
    })
    .expect(302);

  // Get the thing page
  const thingURL = reviewPostResponse.headers.location;
  const thingResponse = await agent
    .get(thingURL)
    .expect(200)
    .expect(/Add a description here/);

  // Find the edit description link
  const editDescMatch = thingResponse.text.match(/<a href="([^"]*\/edit\/description)"/);
  if (!editDescMatch) {
    return t.fail('Could not find edit description link');
  }

  const editDescURL = editDescMatch[1];
  const editDescResponse = await agent
    .get(editDescURL)
    .expect(200)
    .expect(/Edit description/);

  csrf = extractCSRF(editDescResponse.text);

  // Submit the description
  const editDescPostResponse = await agent
    .post(editDescURL)
    .type('form')
    .send({
      _csrf: csrf,
      'thing-description': 'This is a test description for the thing.',
      'thing-language': 'en',
    })
    .expect(302);

  // Verify the description appears on the thing page
  await agent
    .get(editDescPostResponse.headers.location)
    .expect(200)
    .expect(/This is a test description for the thing\./);

  t.pass();
});

test.serial("We can manage a thing's URLs", async t => {
  const agent = supertest.agent(app);
  const username = `ThingUrlManager-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName);
  user.isTrusted = true;
  await user.save();

  const reviewURL = 'https://example.com/original-url';
  const newPrimaryURL = 'https://example.org/new-primary';

  const newReviewResponse = await agent
    .get('/new/review')
    .expect(200)
    .expect(/New review/);

  let csrf = extractCSRF(newReviewResponse.text);

  const reviewPostResponse = await agent
    .post('/new/review')
    .type('form')
    .send({
      _csrf: csrf,
      'review-url': reviewURL,
      'review-title': 'Thing with links',
      'review-text': 'This thing will get a new primary link.',
      'review-rating': '4',
      'review-language': 'en',
      'review-action': 'publish',
    })
    .expect(302);

  const thingURL = reviewPostResponse.headers.location;
  const thingResponse = await agent
    .get(thingURL)
    .expect(200)
    .expect(/Manage links/);

  const manageLinksMatch = thingResponse.text.match(/<a href="([^"]*\/manage\/urls)"/);
  if (!manageLinksMatch) {
    return t.fail('Could not find manage links form for the thing');
  }

  const manageURLsPath = manageLinksMatch[1];
  const manageURLsResponse = await agent.get(manageURLsPath).expect(200);
  csrf = extractCSRF(manageURLsResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token for managing URLs');
  }

  const managePostResponse = await agent
    .post(manageURLsPath)
    .type('form')
    .send({
      _csrf: csrf,
      primary: 1,
      'urls[]': [reviewURL, newPrimaryURL],
    })
    .expect(200);

  t.regex(managePostResponse.text, /links associated with this review subject have been updated/i);

  await agent
    .get(thingURL)
    .expect(200)
    .expect(/example\.org\/new-primary/);

  t.pass();
});

test.serial('We can create a new team', async t => {
  const agent = supertest.agent(app);
  const username = `TeamCreator-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  await agent
    .get('/new/team')
    .expect(403)
    .expect(/do not have permission/);

  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName);
  t.true(isUUID.v4(user.id), 'Previously created user could be found through model');

  user.isTrusted = true;
  await user.save();

  const newTeamResponse = await agent
    .get('/new/team')
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
      'team-action': 'publish',
    })
    .expect(302);

  await agent
    .get(newTeamPostResponse.headers.location)
    .expect(200)
    .expect(/Team: Kale Alliance/);

  t.pass();
});

test.serial('Team join request workflow: join, approve, leave, rejoin', async t => {
  // Create moderator who will manage the team
  const modAgent = supertest.agent(app);
  const modUsername = `TeamMod-${Date.now()}`;
  await registerTestUser(modAgent, {
    username: modUsername,
    password: 'modpass123',
  });

  const modUrlName = modUsername.replace(/ /g, '_');
  const moderator = await User.findByURLName(modUrlName);
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
      'team-action': 'publish',
    })
    .expect(302);

  const teamURL = teamPostResponse.headers.location;
  t.regex(teamURL, /^\/team\//);

  // Create a regular user who will request to join
  const userAgent = supertest.agent(app);
  const username = `TeamJoiner-${Date.now()}`;
  await registerTestUser(userAgent, {
    username: username,
    password: 'userpass123',
  });

  const userUrlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(userUrlName);

  // User visits team page and requests to join
  const teamPageResponse = await userAgent.get(teamURL).expect(200);
  const joinCsrf = extractCSRF(teamPageResponse.text);

  await userAgent
    .post(`${teamURL}/join`)
    .type('form')
    .send({
      _csrf: joinCsrf,
      'join-request-message': 'I would like to join',
      'agree-to-rules': 'on',
    })
    .expect(302);

  // Verify join request was created with status=pending
  let joinRequests = await TeamJoinRequest.filterWhere({ userID: user.id });
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
      'manage-requests-action': 'process-requests',
    })
    .expect(302);

  // Verify request status changed to approved
  joinRequests = await TeamJoinRequest.filterWhere({ userID: user.id });
  t.is(joinRequests[0].status, 'approved');

  // User should now be a member
  const team = await Team.getWithData(joinRequests[0].teamID, { withMembers: true });
  t.true(team.members.some(m => m.id === user.id));

  // User leaves the team
  const teamPageAfterApproval = await userAgent.get(teamURL).expect(200);
  const leaveCsrf = extractCSRF(teamPageAfterApproval.text);

  await userAgent.post(`${teamURL}/leave`).type('form').send({ _csrf: leaveCsrf }).expect(302);

  // Verify request status changed to withdrawn
  joinRequests = await TeamJoinRequest.filterWhere({ userID: user.id });
  t.is(joinRequests[0].status, 'withdrawn');

  // User is no longer a member
  const teamAfterLeave = await Team.getWithData(joinRequests[0].teamID, { withMembers: true });
  t.false(teamAfterLeave.members.some(m => m.id === user.id));

  // User can rejoin - should reuse existing request
  const rejoinPageResponse = await userAgent.get(teamURL).expect(200);
  t.notRegex(
    rejoinPageResponse.text,
    /team has been received/i,
    'Should not show withdrawn request message'
  );

  const rejoinCsrf = extractCSRF(rejoinPageResponse.text);

  await userAgent
    .post(`${teamURL}/join`)
    .type('form')
    .send({
      _csrf: rejoinCsrf,
      'join-request-message': 'I would like to rejoin',
      'agree-to-rules': 'on',
    })
    .expect(302);

  // Verify same request was updated (not a new one created)
  joinRequests = await TeamJoinRequest.filterWhere({ userID: user.id });
  t.is(joinRequests.length, 1, 'Should still only have one request record');
  t.is(joinRequests[0].status, 'pending', 'Status should be back to pending');
  t.is(joinRequests[0].requestMessage, 'I would like to rejoin', 'Message should be updated');

  t.pass();
});

test.serial('We can create a review with team associations', async t => {
  const agent = supertest.agent(app);
  const username = `TeamReviewer-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'teamPassword123',
  });

  // Create a team
  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName);

  const actor = { id: user.id, is_super_user: false, is_trusted: true };
  const teamDraft = await Team.createFirstRevision(actor, { tags: ['review-test'] });
  teamDraft.name = { en: `Test Team for Reviews ${Date.now()}` };
  teamDraft.motto = { en: 'Testing reviews' };
  teamDraft.createdBy = user.id;
  teamDraft.createdOn = new Date();
  teamDraft.originalLanguage = 'en';
  teamDraft.confersPermissions = {};

  teamDraft.members = [actor];
  teamDraft.moderators = [actor];

  const team = await teamDraft.saveAll({ members: true, moderators: true });

  // Create a review with team association
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
      'review-url': 'http://example.com/team-review-test',
      'review-title': 'Team Review Test',
      'review-text': 'This review is associated with a team.',
      'review-rating': 4,
      'review-language': 'en',
      'teams[]': team.id, // Match the form field naming
      'review-action': 'publish',
    })
    .expect(302);

  // Verify the team association was saved in the database
  const reviews = await Review.filterWhere({ createdBy: user.id });
  const latestReview = reviews[reviews.length - 1];

  if (!latestReview) {
    return t.fail('Could not find created review');
  }

  const reviewWithTeams = await Review.getWithData(latestReview.id, { withTeams: true });

  t.is(reviewWithTeams.teams?.length, 1, 'Review should have one team association');
  t.is(reviewWithTeams.teams?.[0].id, team.id, 'Review should be associated with the correct team');

  // Verify the team appears on the page
  const reviewPageResponse = await agent
    .get(postResponse.headers.location)
    .expect(200)
    .expect(/This review is associated with a team/);

  t.regex(
    reviewPageResponse.text,
    /Test Team for Reviews \d+/,
    'Team name should appear on the page'
  );

  t.pass();
});

const signInTrustedUser = async () => {
  const agent = supertest.agent(app);
  const username = `HistoryEditor-${randomUUID().slice(0, 8)}`;
  await registerTestUser(agent, { username, password: 'password123' });
  const user = await User.findByURLName(username);
  user.isTrusted = true;
  await user.save();
  return { agent, user };
};

// Open a form as a browser would, following slug redirects, and submit it
const submitForm = async (agent, path: string, fields: Record<string, unknown>) => {
  const formResponse = await agent.get(path).redirects(5).expect(200);
  const lastRedirect = formResponse.redirects.at(-1);
  const formPath = lastRedirect ? new URL(lastRedirect).pathname : path;
  const revID = formResponse.text.match(/<input type="hidden" value="([^"]*)" name="rev-id"/)?.[1];
  return agent
    .post(formPath)
    .type('form')
    .send({
      _csrf: extractCSRF(formResponse.text),
      ...(revID ? { 'rev-id': revID } : {}),
      ...fields,
    });
};

const expectRedirect = response => {
  if (response.status !== 302)
    throw new Error(`Expected a redirect, got ${response.status} for ${response.req?.path}`);
};

const createThing = async (data: Record<string, unknown>) => {
  const { actor } = await dalFixture.createTestUser('Thing Creator');
  const thing = await Thing.createFirstRevision(actor, { tags: ['create'] });
  thing.urls = [`https://example.com/${randomUUID()}`];
  thing.label = { en: 'Original label', de: 'Ursprünglicher Name' };
  thing.metadata = {
    description: { en: 'Original description', de: 'Ursprüngliche Beschreibung' },
  };
  thing.originalLanguage = 'en';
  thing.createdOn = new Date();
  thing.createdBy = actor.id;
  Object.assign(thing, data);
  await thing.save();
  return thing;
};

const createTeamViaForm = async agent => {
  const response = await submitForm(agent, '/new/team', {
    'team-name': `Team ${randomUUID().slice(0, 8)}`,
    'team-motto': 'Original motto',
    'team-description': 'Original description',
    'team-rules': 'Original rules',
    'team-language': 'en',
    'team-action': 'publish',
  });
  expectRedirect(response);
  return response.headers.location as string;
};

interface RevisionHistoryCase {
  name: string;
  successStatus: number;
  // Uses the Open Library adapter, whose API is mocked during the edit
  mockAdapters?: boolean;
  // Creates the document, with English and German values where the fields are
  // multilingual, and returns its model, ID and edit form URL
  setup(agent, user): Promise<{ Model; id: string; editURL: string }>;
  // Fields submitted with the edit
  submission: Record<string, unknown>;
  // Values the edit changes; a RegExp matches rendered HTML
  changed: Array<{ field: string; read(doc): unknown; value: unknown }>;
  // Values the edit must leave alone
  unchanged: Array<{ field: string; read(doc): unknown }>;
}

const revisionHistoryCases: RevisionHistoryCase[] = [
  {
    name: 'review',
    successStatus: 302,
    async setup(agent) {
      const createResponse = await submitForm(agent, '/new/review', {
        'review-url': `https://example.com/${randomUUID()}`,
        'review-title': 'Original title',
        'review-text': 'Original text',
        'review-rating': '3',
        'review-language': 'en',
        'review-action': 'publish',
      });
      expectRedirect(createResponse);
      const thingResponse = await agent.get(createResponse.headers.location).expect(200);
      const match = thingResponse.text.match(/<a href="\/review\/(.*?)\/edit"/);
      if (!match) throw new Error('Could not find review edit link');
      const editURL = `/review/${match[1]}/edit`;
      expectRedirect(
        await submitForm(agent, editURL, {
          'review-title': 'Ursprünglicher Titel',
          'review-text': 'Ursprünglicher Text',
          'review-rating': '3',
          'review-language': 'de',
          'review-action': 'publish',
        })
      );
      return { Model: Review, id: match[1], editURL };
    },
    submission: {
      'review-title': 'Edited title',
      'review-text': 'Edited text',
      'review-rating': '3',
      'review-language': 'en',
      'review-action': 'publish',
    },
    changed: [
      { field: 'title.en', read: doc => doc.title.en, value: 'Edited title' },
      { field: 'text.en', read: doc => doc.text.en, value: 'Edited text' },
      { field: 'html.en', read: doc => doc.html.en, value: /<p>Edited text<\/p>/ },
    ],
    unchanged: [
      { field: 'title.de', read: doc => doc.title.de },
      { field: 'text.de', read: doc => doc.text.de },
      { field: 'html.de', read: doc => doc.html.de },
      { field: 'starRating', read: doc => doc.starRating },
    ],
  },
  {
    name: 'blog post',
    successStatus: 302,
    async setup(agent) {
      const teamURL = await createTeamViaForm(agent);
      const createResponse = await submitForm(agent, `${teamURL}/new/post`, {
        'post-title': 'Original post title',
        'post-text': 'Original post text',
        'post-language': 'en',
        'post-action': 'publish',
      });
      expectRedirect(createResponse);
      const postURL = createResponse.headers.location as string;
      const editURL = `${postURL}/edit`;
      expectRedirect(
        await submitForm(agent, editURL, {
          'post-title': 'Ursprünglicher Beitragstitel',
          'post-text': 'Ursprünglicher Beitragstext',
          'post-language': 'de',
          'post-action': 'publish',
        })
      );
      return { Model: BlogPost, id: postURL.split('/').pop() as string, editURL };
    },
    submission: {
      'post-title': 'Edited post title',
      'post-text': 'Edited post text',
      'post-language': 'en',
      'post-action': 'publish',
    },
    changed: [
      { field: 'title.en', read: doc => doc.title.en, value: 'Edited post title' },
      { field: 'text.en', read: doc => doc.text.en, value: 'Edited post text' },
      { field: 'html.en', read: doc => doc.html.en, value: /<p>Edited post text<\/p>/ },
    ],
    unchanged: [
      { field: 'title.de', read: doc => doc.title.de },
      { field: 'text.de', read: doc => doc.text.de },
      { field: 'html.de', read: doc => doc.html.de },
      { field: 'teamID', read: doc => doc.teamID },
    ],
  },
  {
    name: 'team',
    successStatus: 302,
    async setup(agent, user) {
      const teamURL = await createTeamViaForm(agent);
      const editURL = `${teamURL}/edit`;
      expectRedirect(
        await submitForm(agent, editURL, {
          'team-name': 'Ursprüngliches Team',
          'team-motto': 'Ursprüngliches Motto',
          'team-description': 'Ursprüngliche Beschreibung',
          'team-rules': 'Ursprüngliche Regeln',
          'team-language': 'de',
          'team-action': 'publish',
        })
      );
      const team = await Team.filterWhere({ createdBy: user.id }).first();
      return { Model: Team, id: team.id, editURL };
    },
    submission: {
      'team-name': `Edited team ${randomUUID().slice(0, 8)}`,
      'team-motto': 'Edited motto',
      'team-description': 'Edited description',
      'team-rules': 'Edited rules',
      'team-language': 'en',
      'team-action': 'publish',
    },
    changed: [
      { field: 'name.en', read: doc => doc.name.en, value: /^Edited team / },
      { field: 'motto.en', read: doc => doc.motto.en, value: 'Edited motto' },
      {
        field: 'description.text.en',
        read: doc => doc.description.text.en,
        value: 'Edited description',
      },
      {
        field: 'description.html.en',
        read: doc => doc.description.html.en,
        value: /<p>Edited description<\/p>/,
      },
      { field: 'rules.text.en', read: doc => doc.rules.text.en, value: 'Edited rules' },
      { field: 'rules.html.en', read: doc => doc.rules.html.en, value: /<p>Edited rules<\/p>/ },
    ],
    unchanged: [
      { field: 'name.de', read: doc => doc.name.de },
      { field: 'motto.de', read: doc => doc.motto.de },
      { field: 'description.text.de', read: doc => doc.description.text.de },
      { field: 'description.html.de', read: doc => doc.description.html.de },
      { field: 'rules.text.de', read: doc => doc.rules.text.de },
      { field: 'rules.html.de', read: doc => doc.rules.html.de },
    ],
  },
  {
    name: 'thing label',
    successStatus: 302,
    async setup() {
      const thing = await createThing({});
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/edit/label` };
    },
    submission: { 'thing-label': 'Edited label', 'thing-language': 'en' },
    changed: [{ field: 'label.en', read: doc => doc.label.en, value: 'Edited label' }],
    unchanged: [
      { field: 'label.de', read: doc => doc.label.de },
      { field: 'metadata.description.en', read: doc => doc.metadata.description.en },
    ],
  },
  {
    name: 'thing description',
    successStatus: 302,
    async setup() {
      const thing = await createThing({});
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/edit/description` };
    },
    submission: { 'thing-description': 'Edited description', 'thing-language': 'en' },
    changed: [
      {
        field: 'metadata.description.en',
        read: doc => doc.metadata.description.en,
        value: 'Edited description',
      },
    ],
    unchanged: [
      { field: 'metadata.description.de', read: doc => doc.metadata.description.de },
      { field: 'label.en', read: doc => doc.label.en },
    ],
  },
  {
    // Subtitle and authors have no edit form; they are written by adapter
    // syncs when a thing's URLs are changed
    name: 'thing subtitle and authors (Open Library sync)',
    successStatus: 200,
    mockAdapters: true,
    async setup() {
      const thing = await createThing({
        metadata: {
          description: { en: 'Original description' },
          subtitle: { en: 'Original subtitle' },
          authors: [{ en: 'Original author' }],
        },
      });
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/manage/urls` };
    },
    submission: { primary: '0', 'urls[]': ['https://openlibrary.org/books/OL25087046M'] },
    changed: [
      {
        field: 'metadata.subtitle',
        read: doc => doc.metadata.subtitle,
        value: { en: 'Making Sense of Stories' },
      },
      {
        field: 'metadata.authors',
        read: doc => doc.metadata.authors,
        value: [{ und: 'Mock Author' }],
      },
      {
        field: 'label.en',
        read: doc => doc.label.en,
        value: 'The Storytelling Animal (Edition)',
      },
    ],
    unchanged: [
      { field: 'metadata.description.en', read: doc => doc.metadata.description.en },
      { field: 'originalLanguage', read: doc => doc.originalLanguage },
    ],
  },
  {
    name: 'thing URLs',
    successStatus: 200,
    async setup() {
      const thing = await createThing({
        sync: { description: { active: true, source: 'wikidata' } },
      });
      return { Model: Thing, id: thing.id, editURL: `/${thing.id}/manage/urls` };
    },
    submission: { primary: '0', 'urls[]': ['https://example.org/edited-link'] },
    changed: [
      { field: 'urls', read: doc => doc.urls, value: ['https://example.org/edited-link'] },
      {
        field: 'sync.description.active',
        read: doc => doc.sync.description.active,
        value: false,
      },
    ],
    unchanged: [
      { field: 'sync.description.source', read: doc => doc.sync.description.source },
      { field: 'label.en', read: doc => doc.label.en },
    ],
  },
  {
    name: 'user bio',
    successStatus: 302,
    async setup(agent, user) {
      const editURL = `/user/${user.urlName}/edit/bio`;
      expectRedirect(
        await submitForm(agent, editURL, { 'bio-text': 'Original bio', 'bio-language': 'en' })
      );
      expectRedirect(
        await submitForm(agent, editURL, {
          'bio-text': 'Ursprüngliche Biografie',
          'bio-language': 'de',
        })
      );
      const userWithMeta = await User.findByURLName(user.urlName, { withData: true });
      return { Model: UserMeta, id: userWithMeta.meta.id, editURL };
    },
    submission: { 'bio-text': 'Edited bio', 'bio-language': 'en' },
    changed: [
      { field: 'bio.text.en', read: doc => doc.bio.text.en, value: 'Edited bio' },
      { field: 'bio.html.en', read: doc => doc.bio.html.en, value: /<p>Edited bio<\/p>/ },
    ],
    unchanged: [
      { field: 'bio.text.de', read: doc => doc.bio.text.de },
      { field: 'bio.html.de', read: doc => doc.bio.html.de },
    ],
  },
];

for (const historyCase of revisionHistoryCases) {
  test.serial(`${historyCase.name}: an edit leaves the archived revision intact`, async t => {
    const { agent, user } = await signInTrustedUser();
    const { Model, id, editURL } = await historyCase.setup(agent, user);

    const before = await Model.get(id);
    const oldRevID = before._revID;
    const oldValues = historyCase.changed.map(({ read }) => read(before));
    const untouchedValues = historyCase.unchanged.map(({ read }) => read(before));
    for (const [index, { field }] of historyCase.unchanged.entries())
      t.not(untouchedValues[index], undefined, `${field} is set before the edit`);

    if (historyCase.mockAdapters) setupAdapterApiMocks();
    try {
      const response = await submitForm(agent, editURL, historyCase.submission);
      t.is(response.status, historyCase.successStatus);
    } finally {
      if (historyCase.mockAdapters) teardownAdapterApiMocks();
    }

    const current = await Model.get(id);
    const archived = await Model.filterWhere({}).getRevisionByRevId(oldRevID, id).first();
    t.not(current._revID, oldRevID, 'the edit created a new revision');
    t.truthy(archived, 'the previous revision can be loaded');
    t.is(archived._revID, oldRevID);

    for (const [index, { field, read, value }] of historyCase.changed.entries()) {
      const newValue = read(current);
      if (value instanceof RegExp) t.regex(String(newValue), value, `current ${field}`);
      else t.deepEqual(newValue, value, `current ${field}`);
      t.notDeepEqual(oldValues[index], newValue, `${field} was changed by the edit`);
      t.deepEqual(read(archived), oldValues[index], `archived ${field} keeps the old value`);
    }

    for (const [index, { field, read }] of historyCase.unchanged.entries()) {
      t.deepEqual(read(current), untouchedValues[index], `current ${field} is untouched`);
      t.deepEqual(read(archived), untouchedValues[index], `archived ${field} is untouched`);
    }
  });
}

test.after.always(async () => {
  unmockSearch();
  const { resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  await dalFixture.cleanup();
});
