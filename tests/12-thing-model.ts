import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'thing_model',
  cleanupTables: ['things', 'users'],
});

let Thing;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([{ key: 'things', alias: 'Thing' }]);

  Thing = models.Thing;
});

test.after.always(unmockSearch);

test('Thing model: create first revision and lookup by URL', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Thing Creator');
  const url = `https://example.com/${randomUUID()}`;

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Test Thing' };
  thingRev.aliases = { en: ['Sample Thing'] };
  thingRev.metadata = { en: { description: 'Metadata description' } };
  thingRev.sync = {};
  thingRev.originalLanguage = 'en';
  thingRev.canonicalSlugName = 'Test Thing';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;

  const saved = await thingRev.save();
  t.truthy(saved.id, 'Thing saved with generated UUID');

  const results = await Thing.lookupByURL(url);
  t.is(results.length, 1, 'lookupByURL returns inserted Thing');
  t.is(results[0].id, saved.id, 'Returned Thing matches saved record');
});

test('Thing model: populateUserInfo sets permission flags', async t => {
  const { actor: creatorActor } = await dalFixture.createTestUser('Thing Creator');
  const { actor: otherUserActor } = await dalFixture.createTestUser('Thing Moderator');

  // Convert actor objects to have camelCase properties for populateUserInfo
  const creator = {
    id: creatorActor.id,
    isTrusted: creatorActor.is_trusted,
    isSuperUser: creatorActor.is_super_user,
    isSiteModerator: false,
  };

  const otherUser = {
    id: otherUserActor.id,
    isTrusted: false,
    isSuperUser: otherUserActor.is_super_user,
    isSiteModerator: true,
  };

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = ['https://example.com/thing'];
  thingRev.label = { en: 'Permission Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  const thing = await thingRev.save();

  thing.populateUserInfo(creator);
  t.true(thing.userIsCreator, 'Creator recognized');
  t.true(thing.userCanEdit, 'Creator can edit');
  t.true(thing.userCanUpload, 'Trusted creator can upload');

  const moderatorView = await Thing.get(thing.id);
  moderatorView.populateUserInfo(otherUser);
  t.false(moderatorView.userIsCreator, 'Moderator not creator');
  t.true(moderatorView.userCanDelete, 'Moderator can delete');
  t.false(moderatorView.userCanUpload, 'Moderator cannot upload without trust');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
