import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'user_team_hydration',
  cleanupTables: ['team_members', 'team_moderators', 'team_slugs', 'teams', 'users'],
});

let User;
let Team;

test.before(async () => {
  await bootstrapPromise;
  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' },
  ]);
  User = models.User;
  Team = models.Team;
});

test.serial('User.findByURLName populates teams and moderatorOf arrays', async t => {
  const username = `Member-${randomUUID()}`;
  const user = await User.create({
    name: username,
    password: 'secret123',
    email: `${username.toLowerCase()}@example.org`,
  });

  const actor = { id: user.id, is_super_user: false, is_trusted: true };
  const teamDraft = await Team.createFirstRevision(actor, { tags: ['create'] });
  teamDraft.name = { en: 'Hydration Team' };
  teamDraft.createdBy = user.id;
  teamDraft.createdOn = new Date();
  teamDraft.originalLanguage = 'en';
  teamDraft.confersPermissions = {};

  const team = await teamDraft.save();
  team.members = [user];
  team.moderators = [user];
  await team.saveAll({ members: true, moderators: true });

  const hydrated = await User.findByURLName(user.urlName, { withTeams: true });

  t.truthy(hydrated, 'User is returned');
  t.true(Array.isArray(hydrated?.teams), 'teams array populated');
  t.true(Array.isArray(hydrated?.moderatorOf), 'moderatorOf array populated');
  t.is(hydrated?.teams.length, 1);
  t.is(hydrated?.teams[0].id, team.id);
  t.is(hydrated?.moderatorOf.length, 1);
  t.is(hydrated?.moderatorOf[0].id, team.id);
});
