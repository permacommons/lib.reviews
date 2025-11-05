import test from 'ava';
import { randomUUID } from 'crypto';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'slug_helpers',
  cleanupTables: ['thing_slugs', 'reviews', 'things', 'users'],
});

import slugs from '../routes/helpers/slugs.ts';
import { createMockRequest, createMockResponse } from './helpers/express-mocks.ts';

let Thing;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'thing_slugs', alias: 'ThingSlug' },
  ]);

  Thing = models.Thing;
});

test.serial('resolveAndLoadThing loads thing by canonical slug', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Slug Creator');

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/thing-${randomUUID()}`];
  thingRev.label = { en: 'Slug Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  thingRev.canonicalSlugName = 'slug-test-thing';
  const thing = await thingRev.save();

  const dal = Thing.dal;
  const slugTable = dal.schemaNamespace ? `${dal.schemaNamespace}thing_slugs` : 'thing_slugs';
  await dal.query(
    `INSERT INTO ${slugTable} (slug, name, base_name, qualifier_part, thing_id, created_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      'slug-test-thing',
      'slug-test-thing',
      'slug-test-thing',
      null,
      thing.id,
      new Date(),
      creator.id,
    ]
  );

  const req = createMockRequest({ originalUrl: '/slug-test-thing' });
  const res = createMockResponse({
    onRedirect: () => {
      throw new Error('Redirect not expected');
    },
  });

  const loadedThing = await slugs.resolveAndLoadThing(req, res, 'slug-test-thing');
  t.truthy(loadedThing, 'Loaded thing returned');
  t.is(loadedThing.id, thing.id, 'Loaded thing matches slug target');
});

test.serial('resolveAndLoadThing redirects to canonical slug when mismatched', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Redirect Creator');

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [`https://example.com/redirect-${randomUUID()}`];
  thingRev.label = { en: 'Redirect Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  thingRev.canonicalSlugName = 'canonical-slug';
  const thing = await thingRev.save();

  const dal = Thing.dal;
  const slugTable = dal.schemaNamespace ? `${dal.schemaNamespace}thing_slugs` : 'thing_slugs';
  await dal.query(
    `INSERT INTO ${slugTable} (slug, name, base_name, qualifier_part, thing_id, created_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['legacy-slug', 'legacy-slug', 'legacy-slug', null, thing.id, new Date(), creator.id]
  );

  const req = createMockRequest({ originalUrl: '/legacy-slug?ref=1' });
  let redirectedTo: string | null = null;
  const res = createMockResponse({
    onRedirect: url => {
      redirectedTo = url;
    },
  });

  await t.throwsAsync(() => slugs.resolveAndLoadThing(req, res, 'legacy-slug'), {
    name: 'RedirectedError',
  });

  t.is(
    redirectedTo,
    '/canonical-slug?ref=1',
    'Redirected to canonical slug with query string preserved'
  );
});

test.serial('resolveAndLoadThing throws DocumentNotFound for unknown slug', async t => {
  const req = createMockRequest({ originalUrl: '/missing-slug' });
  const res = createMockResponse();

  await t.throwsAsync(() => slugs.resolveAndLoadThing(req, res, 'missing-slug'), {
    name: 'DocumentNotFound',
  });
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
