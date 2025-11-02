import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'team_model',
  cleanupTables: [
    'team_moderators',
    'team_members',
    'teams',
    'users'
  ]
});

let User, Team;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'teams', alias: 'Team' }
  ]);

  User = models.User;
  Team = models.Team;
});

test.after.always(unmockSearch);

// ============================================================================
// TEAM MODEL TESTS
// ============================================================================

test.serial('Team model: create team with JSONB multilingual fields', async t => {

  const { actor: founder } = await dalFixture.createTestUser('Team Founder');

  const teamRev = await Team.createFirstRevision(founder, { tags: ['create'] });
  teamRev.name = {
    en: 'Awesome Team',
    de: 'Fantastisches Team',
    fr: 'Équipe Géniale'
  };
  teamRev.motto = {
    en: 'Excellence in everything',
    de: 'Exzellenz in allem',
    fr: 'Excellence en tout'
  };
  teamRev.description = {
    text: {
      en: 'We are a team dedicated to excellence.',
      de: 'Wir sind ein Team, das sich der Exzellenz verschrieben hat.',
      fr: 'Nous sommes une équipe dédiée à l\'excellence.'
    },
    html: {
      en: '<p>We are a team dedicated to <strong>excellence</strong>.</p>',
      de: '<p>Wir sind ein Team, das sich der <strong>Exzellenz</strong> verschrieben hat.</p>',
      fr: '<p>Nous sommes une équipe dédiée à l\'<strong>excellence</strong>.</p>'
    }
  };
  teamRev.rules = {
    text: {
      en: 'Be respectful and collaborative.',
      de: 'Seien Sie respektvoll und kooperativ.',
      fr: 'Soyez respectueux et collaboratif.'
    },
    html: {
      en: '<p>Be <em>respectful</em> and <em>collaborative</em>.</p>',
      de: '<p>Seien Sie <em>respektvoll</em> und <em>kooperativ</em>.</p>',
      fr: '<p>Soyez <em>respectueux</em> et <em>collaboratif</em>.</p>'
    }
  };
  teamRev.modApprovalToJoin = true;
  teamRev.onlyModsCanBlog = false;
  teamRev.createdBy = founder.id;
  teamRev.createdOn = new Date();
  teamRev.canonicalSlugName = 'awesome-team';
  teamRev.originalLanguage = 'en';
  teamRev.confersPermissions = {
    show_error_details: true,
    translate: false
  };

  const saved = await teamRev.save();
  
  t.truthy(saved.id, 'Team saved with generated UUID');
  t.deepEqual(saved.name, teamRev.name, 'Multilingual name stored correctly');
  t.deepEqual(saved.motto, teamRev.motto, 'Multilingual motto stored correctly');
  t.deepEqual(saved.description, teamRev.description, 'Multilingual description stored correctly');
  t.deepEqual(saved.rules, teamRev.rules, 'Multilingual rules stored correctly');
  t.deepEqual(saved.confersPermissions, teamRev.confersPermissions, 'Permissions config stored correctly');
  t.true(saved.modApprovalToJoin, 'Moderation settings stored correctly');
});

test.serial('Team model: create team with members and moderators using saveAll and getWithData', async t => {

  const founderData = await dalFixture.createTestUser('Team Founder');
  const member1Data = await dalFixture.createTestUser('Member 1');
  const member2Data = await dalFixture.createTestUser('Member 2');

  const teamRev = await Team.createFirstRevision(founderData.actor, { tags: ['create'] });
  teamRev.name = { en: 'Test Team with Members' };
  teamRev.createdBy = founderData.id;
  teamRev.createdOn = new Date();

  teamRev.members = [founderData.actor, member1Data.actor, member2Data.actor];
  teamRev.moderators = [founderData.actor, member1Data.actor];

  const saved = await teamRev.saveAll({
    members: true,
    moderators: true
  });

  t.truthy(saved.id, 'Team saved with ID');

  const teamWithData = await Team.getWithData(saved.id);

  t.truthy(teamWithData.members, 'Team has members array');
  t.truthy(teamWithData.moderators, 'Team has moderators array');
  t.is(teamWithData.members.length, 3, 'Team has 3 members');
  t.is(teamWithData.moderators.length, 2, 'Team has 2 moderators');

  const memberIds = teamWithData.members.map(m => m.id).sort();
  const expectedMemberIds = [founderData.id, member1Data.id, member2Data.id].sort();
  t.deepEqual(memberIds, expectedMemberIds, 'All members retrieved correctly');

  const moderatorIds = teamWithData.moderators.map(m => m.id).sort();
  const expectedModeratorIds = [founderData.id, member1Data.id].sort();
  t.deepEqual(moderatorIds, expectedModeratorIds, 'All moderators retrieved correctly');
});

test.serial('Team model: populateUserInfo sets permission flags correctly', async t => {

  const founderData = await dalFixture.createTestUser('Team Founder');
  const moderatorData = await dalFixture.createTestUser('Team Moderator');
  const memberData = await dalFixture.createTestUser('Team Member');
  const outsiderData = await dalFixture.createTestUser('Outsider');
  const siteModeratorData = await dalFixture.createTestUser('Site Moderator');

  // Need to load and update site moderator
  const siteModerator = await User.get(siteModeratorData.id);
  siteModerator.isSiteModerator = true;
  await siteModerator.save();

  // Create team
  const teamRev = await Team.createFirstRevision(founderData.actor, { tags: ['create'] });
  teamRev.name = { en: 'Permission Test Team' };
  teamRev.createdBy = founderData.id;
  teamRev.createdOn = new Date();
  teamRev.onlyModsCanBlog = true;
  const team = await teamRev.save();

  // Need full User objects for populateUserInfo
  const founder = await User.get(founderData.id);
  const moderator = await User.get(moderatorData.id);
  const member = await User.get(memberData.id);
  const outsider = await User.get(outsiderData.id);

  // Add members and moderators to team (simulate join table data)
  team.members = [member, moderator];
  team.moderators = [moderator];

  // Test founder permissions
  team.populateUserInfo(founder);
  t.true(team.userIsFounder, 'Founder recognized');
  t.true(team.userCanEdit, 'Founder can edit (via moderator status)');
  t.false(team.userCanLeave, 'Founder cannot leave');

  // Test moderator permissions
  const moderatorView = await Team.get(team.id);
  moderatorView.members = [member, moderator];
  moderatorView.moderators = [moderator];
  moderatorView.populateUserInfo(moderator);
  t.false(moderatorView.userIsFounder, 'Moderator not founder');
  t.true(moderatorView.userIsMember, 'Moderator is member');
  t.true(moderatorView.userIsModerator, 'Moderator recognized');
  t.true(moderatorView.userCanBlog, 'Moderator can blog');
  t.true(moderatorView.userCanEdit, 'Moderator can edit');
  t.true(moderatorView.userCanLeave, 'Moderator can leave');

  // Test regular member permissions
  const memberView = await Team.get(team.id);
  memberView.members = [member, moderator];
  memberView.moderators = [moderator];
  memberView.populateUserInfo(member);
  t.false(memberView.userIsFounder, 'Member not founder');
  t.true(memberView.userIsMember, 'Member recognized');
  t.false(memberView.userIsModerator, 'Member not moderator');
  t.false(memberView.userCanBlog, 'Member cannot blog (only mods can blog)');
  t.false(memberView.userCanEdit, 'Member cannot edit');
  t.true(memberView.userCanLeave, 'Member can leave');

  // Test outsider permissions
  const outsiderView = await Team.get(team.id);
  outsiderView.members = [member, moderator];
  outsiderView.moderators = [moderator];
  outsiderView.populateUserInfo(outsider);
  t.false(outsiderView.userIsFounder, 'Outsider not founder');
  t.false(outsiderView.userIsMember, 'Outsider not member');
  t.false(outsiderView.userIsModerator, 'Outsider not moderator');
  t.true(outsiderView.userCanJoin, 'Outsider can join');
  t.false(outsiderView.userCanEdit, 'Outsider cannot edit');
  t.false(outsiderView.userCanDelete, 'Outsider cannot delete');

  // Test site moderator permissions
  const siteModView = await Team.get(team.id);
  siteModView.members = [member, moderator];
  siteModView.moderators = [moderator];
  siteModView.populateUserInfo(siteModerator);
  t.true(siteModView.userCanDelete, 'Site moderator can delete team');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
