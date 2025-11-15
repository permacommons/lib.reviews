import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'saveall_m2m',
  cleanupTables: [
    'review_teams',
    'thing_files',
    'team_members',
    'team_moderators',
    'reviews',
    'files',
    'teams',
    'things',
    'users',
  ],
});

let User, Team;

test.before(async () => {
  await bootstrapPromise;
  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' },
  ]);

  User = models.User;
  Team = models.Team;
});

async function createUser(displayName: string) {
  const user = await User.create({
    name: `${displayName}-${randomUUID()}`,
    password: 'hunter22',
  });
  user.email = `${randomUUID()}@example.org`;
  await user.save();
  return user;
}

async function createTeam(creator) {
  const team = await Team.createFirstRevision(creator, { tags: ['create'] });
  team.name = { en: `Team ${randomUUID()}` };
  team.moderators = [creator];
  team.members = [creator];
  team.createdBy = creator.id;
  team.createdOn = new Date();
  await team.save();
  await team.saveAll();
  return team;
}

test.serial('saveAll preserves existing join rows when mutating members', async t => {
  const creator = await createUser('Creator');
  const otherMember = await createUser('Member');
  const team = await createTeam(creator);

  team.members.push(otherMember);
  await team.saveAll();

  const teamMembersTable = dalFixture.getTableName('team_members');
  const rows1 = await dalFixture.dal.query(
    `SELECT user_id, joined_on FROM ${teamMembersTable} WHERE team_id = $1 ORDER BY joined_on ASC`,
    [team.id]
  );
  t.is(rows1.rowCount, 2);
  const originalTimestamps = new Map(rows1.rows.map(row => [row.user_id, row.joined_on]));

  const yetAnotherMember = await createUser('LateMember');
  team.members.push(yetAnotherMember);
  await team.saveAll();

  const rows2 = await dalFixture.dal.query(
    `SELECT user_id, joined_on FROM ${teamMembersTable} WHERE team_id = $1 ORDER BY joined_on ASC`,
    [team.id]
  );
  t.is(rows2.rowCount, 3);
  rows2.rows.forEach(row => {
    if (row.user_id === yetAnotherMember.id) {
      t.truthy(row.joined_on);
    } else {
      t.deepEqual(row.joined_on, originalTimestamps.get(row.user_id));
    }
  });
});

test.serial('saveAll raises when duplicate IDs are provided for a relation', async t => {
  const creator = await createUser('DupCreator');
  const team = await createTeam(creator);

  await t.throwsAsync(
    (async () => {
      team.members = [creator, creator];
      await team.saveAll();
    })(),
    { message: /duplicate entry/i }
  );
});
