import test, { registerCompletionHandler } from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

const require = createRequire(import.meta.url);
const slugs = require('../routes/helpers/slugs');

process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-6', { tableSuffix: 'slug_helpers' });

let User, Thing;

test.before(async t => {
  try {
    await dalFixture.bootstrap();

    const models = await dalFixture.initializeModels([
      {
        key: 'users',
        loader: dal => require('../models-postgres/user').initializeUserModel(dal)
      },
      {
        key: 'things',
        loader: dal => require('../models-postgres/thing').initializeThingModel(dal)
      },
      {
        key: 'thingSlugs',
        loader: dal => require('../models-postgres/thing-slug').initializeModel(dal)
      }
    ]);

    User = models.users;
    Thing = models.things;
  } catch (error) {
    t.log('Skipping slug helper tests - PostgreSQL DAL unavailable:', error.message);
  }
});

test.beforeEach(async () => {
  await dalFixture.cleanupTables(['thing_slugs', 'reviews', 'things', 'users']);
});

test.after.always(async () => {
  await dalFixture.cleanup();
});

registerCompletionHandler(() => {
  const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exit(code);
});

function skipIfNoModels(t) {
  if (!User || !Thing) {
    t.pass('Skipping - PostgreSQL DAL not available');
    return true;
  }
  return false;
}

test.serial('resolveAndLoadThing loads thing by canonical slug', async t => {
  if (skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `SlugCreator-${randomUUID()}`,
    password: 'secret123',
    email: `slugcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/thing-${randomUUID()}`];
  thingRev.label = { en: 'Slug Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  thingRev.canonicalSlugName = 'slug-test-thing';
  const thing = await thingRev.save();

  const dal = Thing.dal;
  const slugTable = dal.tablePrefix ? `${dal.tablePrefix}thing_slugs` : 'thing_slugs';
  await dal.query(
    `INSERT INTO ${slugTable} (slug, name, base_name, qualifier_part, thing_id, created_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['slug-test-thing', 'slug-test-thing', 'slug-test-thing', null, thing.id, new Date(), creator.id]
  );

  const req = { originalUrl: '/slug-test-thing' };
  const res = { redirect: () => { throw new Error('Redirect not expected'); } };

  const loadedThing = await slugs.resolveAndLoadThing(req, res, 'slug-test-thing');
  t.truthy(loadedThing, 'Loaded thing returned');
  t.is(loadedThing.id, thing.id, 'Loaded thing matches slug target');
});

test.serial('resolveAndLoadThing redirects to canonical slug when mismatched', async t => {
  if (skipIfNoModels(t)) return;

  const creator = await User.create({
    name: `RedirectCreator-${randomUUID()}`,
    password: 'secret123',
    email: `redirectcreator-${randomUUID()}@example.com`
  });

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/redirect-${randomUUID()}`];
  thingRev.label = { en: 'Redirect Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  thingRev.canonicalSlugName = 'canonical-slug';
  const thing = await thingRev.save();

  const dal = Thing.dal;
  const slugTable = dal.tablePrefix ? `${dal.tablePrefix}thing_slugs` : 'thing_slugs';
  await dal.query(
    `INSERT INTO ${slugTable} (slug, name, base_name, qualifier_part, thing_id, created_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['legacy-slug', 'legacy-slug', 'legacy-slug', null, thing.id, new Date(), creator.id]
  );

  const req = { originalUrl: '/legacy-slug?ref=1' };
  let redirectedTo = null;
  const res = { redirect: url => { redirectedTo = url; } };

  await t.throwsAsync(() => slugs.resolveAndLoadThing(req, res, 'legacy-slug'), {
    name: 'RedirectedError'
  });

  t.is(redirectedTo, '/canonical-slug?ref=1', 'Redirected to canonical slug with query string preserved');
});

test.serial('resolveAndLoadThing throws DocumentNotFound for unknown slug', async t => {
  if (skipIfNoModels(t)) return;

  const req = { originalUrl: '/missing-slug' };
  const res = { redirect: () => {} };

  await t.throwsAsync(() => slugs.resolveAndLoadThing(req, res, 'missing-slug'), {
    name: 'DocumentNotFound'
  });
});
