import test, { type TestFn } from 'ava';
import supertest from 'supertest';
import { extractCSRF } from './helpers/integration-helpers.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const loadAppModule = () => import('../app.ts');

mockSearch();

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'registration_join_teams',
  cleanupTables: ['team_join_requests', 'team_members', 'team_slugs', 'teams', 'users'],
});

let User, Team, TeamSlug, TeamJoinRequest;
let app;
let openTeamSlugName: string;
let restrictedTeamSlugName: string;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' },
    { key: 'team_slugs', alias: 'TeamSlug' },
    { key: 'team_join_requests', alias: 'TeamJoinRequest' },
  ]);

  User = models.User;
  Team = models.Team;
  TeamSlug = models.TeamSlug;
  TeamJoinRequest = models.TeamJoinRequest;

  const { default: getApp, resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  app = await getApp();
});

test.beforeEach(async () => {
  // Create a dummy creator for the teams
  const uniqueId = Math.random().toString(36).substring(7);
  const creator = await User.create({
    name: `TeamCreator-${uniqueId}`,
    password: 'password',
    email: `creator-${uniqueId}@example.com`,
  });

  // Create Open Team
  const openTeam = await Team.createFirstRevision({ id: creator.id }, { tags: [] });
  openTeam.name = { en: 'Open Team' };
  openTeam.motto = { en: 'Come on in' };
  openTeam.createdBy = creator.id;
  openTeam.createdOn = new Date();
  openTeam.modApprovalToJoin = false;
  await openTeam.save();
  await openTeam.updateSlug(creator.id, 'en');
  await openTeam.save();

  const openSlug = await TeamSlug.getByName(openTeam.canonicalSlugName);
  openTeamSlugName = openSlug ? String(openSlug.name) : '';

  // Create Restricted Team
  const restrictedTeam = await Team.createFirstRevision({ id: creator.id }, { tags: [] });
  restrictedTeam.name = { en: 'Restricted Team' };
  restrictedTeam.motto = { en: 'Knock first' };
  restrictedTeam.createdBy = creator.id;
  restrictedTeam.createdOn = new Date();
  restrictedTeam.modApprovalToJoin = true;
  await restrictedTeam.save();
  await restrictedTeam.updateSlug(creator.id, 'en');
  await restrictedTeam.save();

  const restrictedSlug = await TeamSlug.getByName(restrictedTeam.canonicalSlugName);
  restrictedTeamSlugName = restrictedSlug ? String(restrictedSlug.name) : '';
});

test.serial('Registering with an open team adds user as member', async t => {
  const agent = supertest.agent(app);

  // Get registration page to check for checkbox and get CSRF
  const registerPage = await agent.get(`/register?team=${openTeamSlugName}`).expect(200);

  // Check for the label text (using a loose regex for safety)
  t.regex(registerPage.text, /Join the following team/);

  // Check for the checkbox with correct value and checked state
  // Using [\s\S]* to match anything between attributes
  t.regex(registerPage.text, new RegExp(`value="${openTeamSlugName}"[\\s\\S]*?checked`));

  t.regex(registerPage.text, /Come on in/); // Check motto

  const csrf = extractCSRF(registerPage.text);

  const username = `OpenJoiner-${Date.now()}`;
  await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username,
      password: 'password123',
      'join-teams': openTeamSlugName,
    })
    .expect(302);

  const user = await User.findByURLName(username);
  const userWithTeams = await User.getWithTeams(user.id);
  t.is(userWithTeams.teams.length, 1);
  t.is(userWithTeams.teams[0].canonicalSlugName, openTeamSlugName);
});

test.serial('Registering with a restricted team creates a join request', async t => {
  const agent = supertest.agent(app);

  const registerPage = await agent.get(`/register?team=${restrictedTeamSlugName}`).expect(200);

  t.regex(registerPage.text, /Join the following team/);
  t.regex(registerPage.text, new RegExp(`value="${restrictedTeamSlugName}"[\\s\\S]*?checked`));
  t.regex(registerPage.text, /Knock first/);

  const csrf = extractCSRF(registerPage.text);

  const username = `RestrictedJoiner-${Date.now()}`;
  await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username,
      password: 'password123',
      'join-teams': restrictedTeamSlugName,
    })
    .expect(302);

  const user = await User.findByURLName(username);
  const userWithTeams = await User.getWithTeams(user.id);

  // Should NOT be a member yet
  t.is(userWithTeams.teams ? userWithTeams.teams.length : 0, 0);

  // Should have a join request
  const requests = await TeamJoinRequest.filterWhere({ userID: user.id });
  t.is(requests.length, 1);
  t.is(requests[0].status, 'pending');
  t.regex(requests[0].requestMessage, /Team sign-up requested during registration/);
});

test.serial('Registering with multiple teams handles both types correctly', async t => {
  const agent = supertest.agent(app);
  const query = `team=${openTeamSlugName}&team=${restrictedTeamSlugName}`;

  const registerPage = await agent.get(`/register?${query}`).expect(200);

  // Plural check - matches "Join the following teams"
  t.regex(registerPage.text, /Join the following teams/);

  const csrf = extractCSRF(registerPage.text);

  const username = `MultiJoiner-${Date.now()}`;
  await agent
    .post('/register')
    .type('form')
    .send({
      _csrf: csrf,
      username,
      password: 'password123',
      'join-teams': [openTeamSlugName, restrictedTeamSlugName],
    })
    .expect(302);

  const user = await User.findByURLName(username);

  // Check membership (should be in Open Team)
  const userWithTeams = await User.getWithTeams(user.id);
  t.is(userWithTeams.teams.length, 1);
  t.is(userWithTeams.teams[0].canonicalSlugName, openTeamSlugName);

  // Check join request (should have one for Restricted Team)
  const requests = await TeamJoinRequest.filterWhere({ userID: user.id });
  t.is(requests.length, 1);
  // We'd need to fetch the restricted team ID to be perfectly sure, but assuming only one request exists
  t.is(requests[0].status, 'pending');
});

test.after.always(async () => {
  unmockSearch();
  const { resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  await dalFixture.cleanup();
});
