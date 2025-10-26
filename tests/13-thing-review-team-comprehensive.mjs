import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';

const require = createRequire(import.meta.url);

const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
  schemaNamespace: 'thing_review_team',
  cleanupTables: [
    'review_teams',
    'team_moderators',
    'team_members',
    'reviews',
    'teams',
    'things',
    'users'
  ]
});

let User, Thing, Review, Team;
let NewUserError, ReviewError;

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
    { key: 'teams', alias: 'Team' }
  ]);

  t.log(`Schema prefix: ${dalFixture.tablePrefix}`);

  User = models.User;
  Thing = models.Thing;
  Review = models.Review;
  Team = models.Team;

  ({ NewUserError } = require('../models-postgres/user'));
  ({ ReviewError } = require('../models-postgres/review'));
});

test.after.always(unmockSearch);

async function skipIfNoModels(t) {
  if (await skipIfUnavailable(t)) return true;
  if (!User || !Thing || !Review || !Team) {
    const skipMessage = 'Skipping - PostgreSQL DAL not available';
    t.log(skipMessage);
    t.pass(skipMessage);
    return true;
  }
  return false;
}

// ============================================================================
// MODEL INITIALIZATION TESTS
// ============================================================================

test.serial('Thing, Review, and Team initializers attach to shared DAL', async t => {
  if (await skipIfNoModels(t)) return;

  t.truthy(Thing.dal === Review.dal && Review.dal === Team.dal, 'Models share the same DAL instance');
  t.true(Thing.tableName.startsWith(dalFixture.tablePrefix), 'Thing table respects prefix');
  t.true(Review.tableName.startsWith(dalFixture.tablePrefix), 'Review table respects prefix');
  t.true(Team.tableName.startsWith(dalFixture.tablePrefix), 'Team table respects prefix');
});

// ============================================================================
// THING MODEL TESTS
// ============================================================================

test.serial('Thing model: create first revision with JSONB multilingual fields', async t => {
  if (await skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `Creator-${randomUUID()}`,
    password: 'secret123',
    email: `creator-${randomUUID()}@example.com`
  });

  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  
  thingRev.urls = [url];
  thingRev.label = { 
    en: 'Test Thing',
    de: 'Test Ding',
    fr: 'Chose de Test'
  };
  thingRev.aliases = { 
    en: ['Sample Thing', 'Example Item'],
    de: ['Beispiel Ding'],
    fr: ['Exemple Chose']
  };
  thingRev.metadata = {
    description: {
      en: 'English description',
      de: 'Deutsche Beschreibung',
      fr: 'Description française'
    },
    subtitle: {
      en: 'English subtitle'
    },
    authors: [
      {
        en: 'Author Name',
        de: 'Autorenname'
      }
    ]
  };
  thingRev.sync = {
    label: { active: true, source: 'wikidata', updated: new Date() }
  };
  thingRev.originalLanguage = 'en';
  thingRev.canonicalSlugName = 'test-thing';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;

  const saved = await thingRev.save();
  
  t.truthy(saved.id, 'Thing saved with generated UUID');
  t.deepEqual(saved.label, thingRev.label, 'Multilingual label stored correctly');
  t.deepEqual(saved.aliases, thingRev.aliases, 'Multilingual aliases stored correctly');
  t.deepEqual(saved.metadata, thingRev.metadata, 'Grouped metadata stored correctly');
  t.deepEqual(saved.sync, thingRev.sync, 'Sync data stored correctly');
  t.deepEqual(saved.urls, [url], 'URLs array stored correctly');
});

test.serial('Thing model: lookupByURL finds things by URL', async t => {
  if (await skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `URLCreator-${randomUUID()}`,
    password: 'secret123',
    email: `urlcreator-${randomUUID()}@example.com`
  });

  const url1 = `https://example.com/item1-${randomUUID()}`;
  const url2 = `https://example.com/item2-${randomUUID()}`;

  // Create first thing
  const thing1Rev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thing1Rev.urls = [url1];
  thing1Rev.label = { en: 'First Thing' };
  thing1Rev.createdOn = new Date();
  thing1Rev.createdBy = creator.id;
  const thing1 = await thing1Rev.save();

  // Create second thing
  const thing2Rev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thing2Rev.urls = [url2];
  thing2Rev.label = { en: 'Second Thing' };
  thing2Rev.createdOn = new Date();
  thing2Rev.createdBy = creator.id;
  const thing2 = await thing2Rev.save();

  // Test lookup
  const results1 = await Thing.lookupByURL(url1);
  t.is(results1.length, 1, 'Found exactly one thing for URL1');
  t.is(results1[0].id, thing1.id, 'Found correct thing for URL1');

  const results2 = await Thing.lookupByURL(url2);
  t.is(results2.length, 1, 'Found exactly one thing for URL2');
  t.is(results2[0].id, thing2.id, 'Found correct thing for URL2');

  const noResults = await Thing.lookupByURL('https://nonexistent.com');
  t.is(noResults.length, 0, 'No results for non-existent URL');
});

test.serial('Thing model: populateUserInfo sets permission flags correctly', async t => {
  if (await skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });
  creator.isTrusted = true;
  await creator.save();

  const moderator = await User.create({
    name: `Moderator-${randomUUID()}`,
    password: 'secret123',
    email: `moderator-${randomUUID()}@example.com`
  });
  moderator.isSiteModerator = true;
  await moderator.save();

  const regularUser = await User.create({
    name: `Regular-${randomUUID()}`,
    password: 'secret123',
    email: `regular-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = ['https://example.com/permissions-test'];
  thingRev.label = { en: 'Permission Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  const thing = await thingRev.save();

  // Test creator permissions
  thing.populateUserInfo(creator);
  t.true(thing.userIsCreator, 'Creator recognized');
  t.true(thing.userCanEdit, 'Creator can edit');
  t.true(thing.userCanUpload, 'Trusted creator can upload');
  t.false(thing.userCanDelete, 'Creator cannot delete (not moderator)');

  // Test moderator permissions
  const moderatorView = await Thing.get(thing.id);
  moderatorView.populateUserInfo(moderator);
  t.false(moderatorView.userIsCreator, 'Moderator not creator');
  t.false(moderatorView.userCanEdit, 'Moderator cannot edit (not trusted)');
  t.true(moderatorView.userCanDelete, 'Moderator can delete');
  t.false(moderatorView.userCanUpload, 'Moderator cannot upload (not trusted)');

  // Test regular user permissions
  const regularView = await Thing.get(thing.id);
  regularView.populateUserInfo(regularUser);
  t.false(regularView.userIsCreator, 'Regular user not creator');
  t.false(regularView.userCanEdit, 'Regular user cannot edit');
  t.false(regularView.userCanDelete, 'Regular user cannot delete');
  t.false(regularView.userCanUpload, 'Regular user cannot upload');
});

test.serial('Thing model: revision system works correctly', async t => {
  if (await skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `RevisionCreator-${randomUUID()}`,
    password: 'secret123',
    email: `revisioncreator-${randomUUID()}@example.com`
  });

  // Create first revision
  const firstRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  firstRev.urls = ['https://example.com/revision-test'];
  firstRev.label = { en: 'Original Label' };
  firstRev.createdOn = new Date();
  firstRev.createdBy = creator.id;
  await firstRev.save();

  // Create second revision
  const secondRev = await firstRev.newRevision(creator, { tags: ['edit'] });
  secondRev.label = { en: 'Updated Label', de: 'Aktualisiertes Label' };
  await secondRev.save();

  // Verify current revision
  const current = await Thing.getNotStaleOrDeleted(firstRev.id);
  t.is(current.label.en, 'Updated Label', 'Current revision has updated label');
  t.is(current.label.de, 'Aktualisiertes Label', 'Current revision has new language');

  // Verify old revision exists but is not returned by getNotStaleOrDeleted
  const allRevisions = await Thing.dal.query(
    `SELECT * FROM ${Thing.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [firstRev.id]
  );
  t.is(allRevisions.rows.length, 2, 'Two revisions exist in database');
});

// ============================================================================
// REVIEW MODEL TESTS
// ============================================================================

test.serial('Review model: create review with JSONB multilingual content', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `ReviewAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `reviewauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  // Create a thing to review
  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/reviewable-${randomUUID()}`];
  thingRev.label = { en: 'Reviewable Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  // Create review using createFirstRevision
  const review = await Review.createFirstRevision(author, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = {
    en: 'Great Product',
    de: 'Tolles Produkt',
    fr: 'Excellent Produit'
  };
  review.text = {
    en: 'This is an excellent product that I highly recommend.',
    de: 'Dies ist ein ausgezeichnetes Produkt, das ich sehr empfehle.',
    fr: 'C\'est un excellent produit que je recommande vivement.'
  };
  review.html = {
    en: '<p>This is an <strong>excellent</strong> product that I highly recommend.</p>',
    de: '<p>Dies ist ein <strong>ausgezeichnetes</strong> Produkt, das ich sehr empfehle.</p>',
    fr: '<p>C\'est un <strong>excellent</strong> produit que je recommande vivement.</p>'
  };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = author.id;
  review.originalLanguage = 'en';

  const saved = await review.save();
  
  t.truthy(saved.id, 'Review saved with generated UUID');
  t.deepEqual(saved.title, review.title, 'Multilingual title stored correctly');
  t.deepEqual(saved.text, review.text, 'Multilingual text stored correctly');
  t.deepEqual(saved.html, review.html, 'Multilingual HTML stored correctly');
  t.is(saved.starRating, 5, 'Star rating stored correctly');
  t.is(saved.thingID, thing.id, 'Thing relationship stored correctly');
});

test.serial('Review model: populateUserInfo sets permission flags correctly', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `ReviewAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `reviewauthor-${randomUUID()}@example.com`
  });

  const moderator = await User.create({
    name: `ReviewModerator-${randomUUID()}`,
    password: 'secret123',
    email: `reviewmoderator-${randomUUID()}@example.com`
  });
  moderator.isSiteModerator = true;
  await moderator.save();

  const otherUser = await User.create({
    name: `OtherUser-${randomUUID()}`,
    password: 'secret123',
    email: `otheruser-${randomUUID()}@example.com`
  });

  // Create a thing and review
  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/reviewable-${randomUUID()}`];
  thingRev.label = { en: 'Reviewable Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');
  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Test Review' },
    text: { en: 'Test review content' },
    star_rating: 4,
    created_on: new Date(),
    created_by: author.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: author.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review.save();

  // Test author permissions
  review.populateUserInfo(author);
  t.true(review.userIsAuthor, 'Author recognized');
  t.true(review.userCanEdit, 'Author can edit');
  t.true(review.userCanDelete, 'Author can delete');

  // Test moderator permissions
  const moderatorView = await Review.get(review.id);
  moderatorView.populateUserInfo(moderator);
  t.false(moderatorView.userIsAuthor, 'Moderator not author');
  t.false(moderatorView.userCanEdit, 'Moderator cannot edit (not author)');
  t.true(moderatorView.userCanDelete, 'Moderator can delete');

  // Test other user permissions
  const otherView = await Review.get(review.id);
  otherView.populateUserInfo(otherUser);
  t.false(otherView.userIsAuthor, 'Other user not author');
  t.false(otherView.userCanEdit, 'Other user cannot edit');
  t.false(otherView.userCanDelete, 'Other user cannot delete');
});

test.serial('Review model: star rating validation works', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `RatingAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `ratingauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/rating-test-${randomUUID()}`];
  thingRev.label = { en: 'Rating Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const { randomUUID: uuid } = require('crypto');

  // Test invalid ratings
  const invalidRatings = [0, 6, -1, 3.5, 'five'];
  
  for (const rating of invalidRatings) {
    const review = new Review({
      thing_id: thing.id,
      title: { en: 'Invalid Rating Test' },
      text: { en: 'Testing invalid rating' },
      star_rating: rating,
      created_on: new Date(),
      created_by: author.id,
      original_language: 'en',
      _rev_id: uuid(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });

    await t.throwsAsync(() => review.save(), undefined, `Rating ${rating} should be invalid`);
  }

  // Test valid ratings
  const validRatings = [1, 2, 3, 4, 5];
  
  for (const rating of validRatings) {
    const review = new Review({
      thing_id: thing.id,
      title: { en: `Valid Rating ${rating}` },
      text: { en: `Testing valid rating ${rating}` },
      star_rating: rating,
      created_on: new Date(),
      created_by: author.id,
      original_language: 'en',
      _rev_id: uuid(),
      _rev_user: author.id,
      _rev_date: new Date(),
      _rev_tags: ['create']
    });

    const saved = await review.save();
    t.is(saved.starRating, rating, `Rating ${rating} should be valid`);
  }
});

test.serial('Review model: getFeed joins thing data', async t => {
  if (await skipIfNoModels(t)) return;

  const author = await User.create({
    name: `FeedAuthor-${randomUUID()}`,
    password: 'secret123',
    email: `feedauthor-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `FeedThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `feedthingcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  const reviewUrl = `https://example.com/reviewable-${randomUUID()}`;
  const createdAt = new Date();

  thingRev.urls = [reviewUrl];
  thingRev.label = { en: 'Feed Thing' };
  thingRev.createdOn = createdAt;
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const reviewRev = await Review.createFirstRevision(author, { tags: ['create'] });
  reviewRev.thingID = thing.id;
  reviewRev.title = { en: 'Feed Review' };
  reviewRev.text = { en: 'Feed review content' };
  reviewRev.html = { en: '<p>Feed review content</p>' };
  reviewRev.starRating = 4;
  reviewRev.createdOn = createdAt;
  reviewRev.createdBy = author.id;
  reviewRev.originalLanguage = 'en';
  await reviewRev.save();

  const feed = await Review.getFeed({ limit: 5, withThing: true, withTeams: false });
  t.true(Array.isArray(feed.feedItems), 'Feed items array returned');
  t.true(feed.feedItems.length > 0, 'Feed includes created review');

  const [firstItem] = feed.feedItems;
  t.truthy(firstItem.thing, 'Thing join included in feed item');
  t.is(firstItem.thing.id, thing.id, 'Thing join matches review thing ID');
  t.is(firstItem.thing.label.en, 'Feed Thing', 'Thing label preserved in join');
  t.is(firstItem.thing.urls[0], reviewUrl, 'Thing URLs included in join');
});

// ============================================================================
// TEAM MODEL TESTS
// ============================================================================

test.serial('Team model: create team with JSONB multilingual fields', async t => {
  if (await skipIfNoModels(t)) return;

  const founder = await User.create({
    name: `TeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `teamfounder-${randomUUID()}@example.com`
  });

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

test.serial('Team model: populateUserInfo sets permission flags correctly', async t => {
  if (await skipIfNoModels(t)) return;

  const founder = await User.create({
    name: `TeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `teamfounder-${randomUUID()}@example.com`
  });

  const moderator = await User.create({
    name: `TeamModerator-${randomUUID()}`,
    password: 'secret123',
    email: `teammoderator-${randomUUID()}@example.com`
  });

  const member = await User.create({
    name: `TeamMember-${randomUUID()}`,
    password: 'secret123',
    email: `teammember-${randomUUID()}@example.com`
  });

  const outsider = await User.create({
    name: `Outsider-${randomUUID()}`,
    password: 'secret123',
    email: `outsider-${randomUUID()}@example.com`
  });

  const siteModerator = await User.create({
    name: `SiteModerator-${randomUUID()}`,
    password: 'secret123',
    email: `sitemoderator-${randomUUID()}@example.com`
  });
  siteModerator.isSiteModerator = true;
  await siteModerator.save();

  // Create team
  const teamRev = await Team.createFirstRevision(founder, { tags: ['create'] });
  teamRev.name = { en: 'Permission Test Team' };
  teamRev.createdBy = founder.id;
  teamRev.createdOn = new Date();
  teamRev.onlyModsCanBlog = true;
  const team = await teamRev.save();

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

// ============================================================================
// INTEGRATION TESTS BETWEEN MODELS
// ============================================================================

test.serial('Integration: Thing-Review relationship and metrics', async t => {
  if (await skipIfNoModels(t)) return;

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  const reviewer1 = await User.create({
    name: `Reviewer1-${randomUUID()}`,
    password: 'secret123',
    email: `reviewer1-${randomUUID()}@example.com`
  });

  const reviewer2 = await User.create({
    name: `Reviewer2-${randomUUID()}`,
    password: 'secret123',
    email: `reviewer2-${randomUUID()}@example.com`
  });

  // Create a thing
  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/integration-test-${randomUUID()}`];
  thingRev.label = { en: 'Integration Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  // Create multiple reviews for the thing
  const { randomUUID: uuid } = require('crypto');
  
  const review1 = new Review({
    thing_id: thing.id,
    title: { en: 'Great Product' },
    text: { en: 'I love this product!' },
    star_rating: 5,
    created_on: new Date(),
    created_by: reviewer1.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer1.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review1.save();

  const review2 = new Review({
    thing_id: thing.id,
    title: { en: 'Good but not perfect' },
    text: { en: 'It has some issues but overall good.' },
    star_rating: 3,
    created_on: new Date(),
    created_by: reviewer2.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer2.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review2.save();

  // Test thing metrics
  const avgRating = await thing.getAverageStarRating();
  const reviewCount = await thing.getReviewCount();
  
  t.is(avgRating, 4, 'Average rating calculated correctly (5+3)/2 = 4');
  t.is(reviewCount, 2, 'Review count calculated correctly');

  // Test populate review metrics
  await thing.populateReviewMetrics();
  t.is(thing.averageStarRating, 4, 'Average rating populated correctly');
  t.is(thing.numberOfReviews, 2, 'Review count populated correctly');
});

test.serial('Integration: Team-Review association', async t => {
  if (await skipIfNoModels(t)) return;

  const teamFounder = await User.create({
    name: `TeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `teamfounder-${randomUUID()}@example.com`
  });

  const reviewer = await User.create({
    name: `TeamReviewer-${randomUUID()}`,
    password: 'secret123',
    email: `teamreviewer-${randomUUID()}@example.com`
  });

  const thingCreator = await User.create({
    name: `ThingCreator-${randomUUID()}`,
    password: 'secret123',
    email: `thingcreator-${randomUUID()}@example.com`
  });

  // Create team
  const teamRev = await Team.createFirstRevision(teamFounder, { tags: ['create'] });
  teamRev.name = { en: 'Review Team' };
  teamRev.createdBy = teamFounder.id;
  teamRev.createdOn = new Date();
  const team = await teamRev.save();

  // Create thing
  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/team-review-test-${randomUUID()}`];
  thingRev.label = { en: 'Team Review Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  // Create review
  const { randomUUID: uuid } = require('crypto');
  const review = new Review({
    thing_id: thing.id,
    title: { en: 'Team Review' },
    text: { en: 'This is a review from our team.' },
    star_rating: 4,
    created_on: new Date(),
    created_by: reviewer.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: reviewer.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await review.save();

  // Associate review with team (simulate join table)
  const reviewTeamTableName = dalFixture.tablePrefix ? 
    `${dalFixture.tablePrefix}review_teams` : 'review_teams';
  
  await dalFixture.query(
    `INSERT INTO ${reviewTeamTableName} (review_id, team_id) VALUES ($1, $2)`,
    [review.id, team.id]
  );

  // Verify association exists
  const associationResult = await dalFixture.query(
    `SELECT * FROM ${reviewTeamTableName} WHERE review_id = $1 AND team_id = $2`,
    [review.id, team.id]
  );
  
  t.is(associationResult.rows.length, 1, 'Review-team association created');
  t.is(associationResult.rows[0].review_id, review.id, 'Review ID matches');
  t.is(associationResult.rows[0].team_id, team.id, 'Team ID matches');
});

test.serial('Integration: Review.create with team associations', async t => {
  if (await skipIfNoModels(t)) return;

  const teamFounder = await User.create({
    name: `CreateTeamFounder-${randomUUID()}`,
    password: 'secret123',
    email: `createteamfounder-${randomUUID()}@example.com`
  });

  const reviewer = await User.create({
    name: `CreateReviewer-${randomUUID()}`,
    password: 'secret123',
    email: `createreviewer-${randomUUID()}@example.com`
  });

  // Create team
  const teamRev = await Team.createFirstRevision(teamFounder, { tags: ['create'] });
  teamRev.name = { en: 'Create Review Team' };
  teamRev.createdBy = teamFounder.id;
  teamRev.createdOn = new Date();
  const team = await teamRev.save();

  // Create review with team association using Review.create
  const reviewUrl = `https://example.com/create-team-review-${randomUUID()}`;
  const reviewObj = {
    url: reviewUrl,
    title: { en: 'Team Review via Create' },
    text: { en: 'This review was created with team associations.' },
    html: { en: '<p>This review was created with team associations.</p>' },
    starRating: 5,
    createdOn: new Date(),
    createdBy: reviewer.id,
    originalLanguage: 'en',
    teams: [team] // Associate with team
  };

  const review = await Review.create(reviewObj, { tags: ['create'] });

  t.truthy(review.id, 'Review created successfully');
  t.truthy(review.thingID, 'Thing created for review');

  // Verify team association was created
  const reviewTeamTableName = dalFixture.tablePrefix ? 
    `${dalFixture.tablePrefix}review_teams` : 'review_teams';
  
  const associationResult = await dalFixture.query(
    `SELECT * FROM ${reviewTeamTableName} WHERE review_id = $1 AND team_id = $2`,
    [review.id, team.id]
  );
  
  t.is(associationResult.rows.length, 1, 'Team association created via Review.create');
  t.is(associationResult.rows[0].review_id, review.id, 'Review ID matches in association');
  t.is(associationResult.rows[0].team_id, team.id, 'Team ID matches in association');

  // Test getWithData includes teams
  const reviewWithData = await Review.getWithData(review.id);
  t.truthy(reviewWithData.teams, 'Teams included in getWithData');
  t.is(reviewWithData.teams.length, 1, 'One team associated');
  t.is(reviewWithData.teams[0].id, team.id, 'Correct team associated');
});

test.serial('Integration: Revision system across all models', async t => {
  if (await skipIfNoModels(t)) return;

  const user = await User.create({
    name: `RevisionUser-${randomUUID()}`,
    password: 'secret123',
    email: `revisionuser-${randomUUID()}@example.com`
  });

  // Test Thing revisions
  const thingRev1 = await Thing.createFirstRevision(user, { tags: ['create'] });
  thingRev1.urls = [`https://example.com/revision-integration-${randomUUID()}`];
  thingRev1.label = { en: 'Original Thing Label' };
  thingRev1.createdOn = new Date();
  thingRev1.createdBy = user.id;
  await thingRev1.save();

  const thingRev2 = await thingRev1.newRevision(user, { tags: ['edit'] });
  thingRev2.label = { en: 'Updated Thing Label' };
  await thingRev2.save();

  // Test Team revisions
  const teamRev1 = await Team.createFirstRevision(user, { tags: ['create'] });
  teamRev1.name = { en: 'Original Team Name' };
  teamRev1.createdBy = user.id;
  teamRev1.createdOn = new Date();
  await teamRev1.save();

  const teamRev2 = await teamRev1.newRevision(user, { tags: ['edit'] });
  teamRev2.name = { en: 'Updated Team Name' };
  await teamRev2.save();

  // Test Review revisions
  const { randomUUID: uuid } = require('crypto');
  const reviewRev1 = new Review({
    thing_id: thingRev1.id,
    title: { en: 'Original Review Title' },
    text: { en: 'Original review content' },
    star_rating: 3,
    created_on: new Date(),
    created_by: user.id,
    original_language: 'en',
    _rev_id: uuid(),
    _rev_user: user.id,
    _rev_date: new Date(),
    _rev_tags: ['create']
  });
  await reviewRev1.save();

  const reviewRev2 = await reviewRev1.newRevision(user, { tags: ['edit'] });
  reviewRev2.title = { en: 'Updated Review Title' };
  reviewRev2.text = { en: 'Updated review content' };
  await reviewRev2.save();

  // Verify current revisions
  const currentThing = await Thing.getNotStaleOrDeleted(thingRev1.id);
  const currentTeam = await Team.getNotStaleOrDeleted(teamRev1.id);
  const currentReview = await Review.getNotStaleOrDeleted(reviewRev1.id);

  t.is(currentThing.label.en, 'Updated Thing Label', 'Thing current revision correct');
  t.is(currentTeam.name.en, 'Updated Team Name', 'Team current revision correct');
  t.is(currentReview.title.en, 'Updated Review Title', 'Review current revision correct');

  // Verify revision counts
  const thingRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Thing.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [thingRev1.id]
  );
  const teamRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Team.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [teamRev1.id]
  );
  const reviewRevisions = await dalFixture.query(
    `SELECT COUNT(*) as count FROM ${Review.tableName} WHERE id = $1 OR _old_rev_of = $1`,
    [reviewRev1.id]
  );

  t.is(parseInt(thingRevisions.rows[0].count), 2, 'Thing has 2 revisions');
  t.is(parseInt(teamRevisions.rows[0].count), 2, 'Team has 2 revisions');
  t.is(parseInt(reviewRevisions.rows[0].count), 2, 'Review has 2 revisions');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
