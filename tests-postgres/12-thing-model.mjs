import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';
import { thingTableDefinition } from './helpers/table-definitions.mjs';

const require = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-4';
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-4');

let Thing;

test.before(async t => {
  // Stub search module to avoid starting Elasticsearch clients during tests
  const searchPath = require.resolve('../search');
  require.cache[searchPath] = {
    exports: {
      indexThing() {},
      searchThings: async () => ({}),
      getClient: () => ({})
    }
  };

  try {
    await dalFixture.bootstrap();

    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      t.log('pgcrypto extension not available:', extensionError.message);
    }

    await dalFixture.createTestTables([
      thingTableDefinition()
    ]);

    const models = await dalFixture.initializeModels([
      {
        key: 'things',
        loader: dal => require('../models-postgres/thing').initializeThingModel(dal)
      }
    ]);

    Thing = models.things;
  } catch (error) {
    t.log('PostgreSQL not available, skipping Thing model tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.beforeEach(async () => {
  await dalFixture.cleanupTables(['things']);
});

test.after.always(async () => {
  await dalFixture.dropTestTables(['things']);
  await dalFixture.cleanup();
});

function skipIfNoThing(t) {
  if (!Thing) {
    t.pass('Skipping - PostgreSQL DAL not available');
    return true;
  }
  return false;
}

test('Thing model: create first revision and lookup by URL', async t => {
  if (skipIfNoThing(t)) return;

  const creator = { id: randomUUID(), is_super_user: false, is_trusted: true };
  const url = `https://example.com/${randomUUID()}`;

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Test Thing' };
  thingRev.aliases = { en: ['Sample Thing'] };
  thingRev.metadata = { en: { description: 'Metadata description' } };
  thingRev.sync = {};
  thingRev.original_language = 'en';
  thingRev.canonical_slug_name = 'Test Thing';
  thingRev.created_on = new Date();
  thingRev.created_by = creator.id;

  const saved = await thingRev.save();
  t.truthy(saved.id, 'Thing saved with generated UUID');

  const results = await Thing.lookupByURL(url);
  t.is(results.length, 1, 'lookupByURL returns inserted Thing');
  t.is(results[0].id, saved.id, 'Returned Thing matches saved record');
});

test('Thing model: populateUserInfo sets permission flags', async t => {
  if (skipIfNoThing(t)) return;

  const creator = { id: randomUUID(), is_super_user: false, is_trusted: true };
  const otherUser = { id: randomUUID(), is_super_user: false, is_trusted: false, is_site_moderator: true };

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = ['https://example.com/thing'];
  thingRev.label = { en: 'Permission Thing' };
  thingRev.created_on = new Date();
  thingRev.created_by = creator.id;
  const thing = await thingRev.save();

  thing.populateUserInfo(creator);
  t.true(thing.user_is_creator, 'Creator recognized');
  t.true(thing.user_can_edit, 'Creator can edit');
  t.true(thing.user_can_upload, 'Trusted creator can upload');

  const moderatorView = await Thing.get(thing.id);
  moderatorView.populateUserInfo(otherUser);
  t.false(moderatorView.user_is_creator, 'Moderator not creator');
  t.true(moderatorView.user_can_delete, 'Moderator can delete');
  t.false(moderatorView.user_can_upload, 'Moderator cannot upload without trust');
});
