import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const require = createRequire(import.meta.url);

const { dalFixture, skipIfUnavailable } = setupPostgresTest(test, {
  schemaNamespace: 'slug_helpers',
  cleanupTables: ['thing_slugs', 'reviews', 'things', 'users']
});

const slugs = require('../routes/helpers/slugs');

let User, Thing;

test.before(async t => {
  if (await skipIfUnavailable(t)) return;

  try {
    const models = await dalFixture.initializeModels([
      { key: 'users', alias: 'User' },
      { key: 'things', alias: 'Thing' },
      { key: 'thing_slugs', alias: 'ThingSlug' }
    ]);

    User = models.User;
    Thing = models.Thing;
  } catch (error) {
    const skipMessage = `Skipping slug helper tests - PostgreSQL DAL unavailable: ${error.message}`;
    t.log(skipMessage);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

async function skipIfNoModels(t) {
  if (await skipIfUnavailable(t)) return true;
  if (!User || !Thing) {
    const skipMessage = 'Skipping - PostgreSQL DAL not available';
    t.log(skipMessage);
    t.pass(skipMessage);
    return true;
  }
  return false;
}

test.serial('resolveAndLoadThing loads thing by canonical slug', async t => {
  if (await skipIfNoModels(t)) return;

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
  if (await skipIfNoModels(t)) return;

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
  if (await skipIfNoModels(t)) return;

  const req = { originalUrl: '/missing-slug' };
  const res = { redirect: () => {} };

  await t.throwsAsync(() => slugs.resolveAndLoadThing(req, res, 'missing-slug'), {
    name: 'DocumentNotFound'
  });
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
