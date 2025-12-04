import test from 'ava';
import { randomUUID } from 'crypto';
import supertest from 'supertest';
import { extractCSRF, registerTestUser } from './helpers/integration-helpers.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const loadAppModule = () => import('../app.ts');

mockSearch();

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'thing_deletion',
  cleanupTables: ['reviews', 'things', 'users'],
});

let Thing, User;
let app;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'users', alias: 'User' },
    { key: 'reviews', alias: 'Review' },
  ]);

  Thing = models.Thing;
  User = models.User;

  const { default: getApp, resetAppForTesting } = await loadAppModule();
  if (typeof resetAppForTesting === 'function') await resetAppForTesting();
  app = await getApp();
});

test.after.always(unmockSearch);

test('Thing model: deleteAllRevisions marks thing as deleted', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Thing Creator');
  const url = `https://example.com/${randomUUID()}`;

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Test Thing to Delete' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;

  const saved = await thingRev.save();
  const thingID = saved.id;

  t.truthy(thingID, 'Thing created successfully');

  // Delete the thing
  await saved.deleteAllRevisions(creator);

  // Verify it's marked as deleted
  const deletedThing = await Thing.get(thingID);
  t.true(deletedThing._data._rev_deleted, 'Thing marked as deleted');

  // Verify getNotStaleOrDeleted throws error
  await t.throwsAsync(
    () => Thing.getNotStaleOrDeleted(thingID),
    undefined,
    'Getting deleted thing throws error'
  );
});

test('Thing model: userCanDelete permission check', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Thing Creator');
  const { id: otherUserId } = await dalFixture.createTestUser('Other User');
  const { id: moderatorId } = await dalFixture.createTestUser('Site Moderator');
  const url = `https://example.com/${randomUUID()}`;

  // Load and update site moderator
  const moderator = await User.get(moderatorId);
  moderator.isSiteModerator = true;
  await moderator.save();

  // Load regular users
  const creatorUser = await User.get(creator.id);
  const otherUser = await User.get(otherUserId);

  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Test Thing Permissions' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;

  const saved = await thingRev.save();

  // Site moderator should be able to delete
  saved.populateUserInfo(moderator);
  t.true(saved.userCanDelete, 'Site moderator can delete thing');

  // Creator should NOT be able to delete (only moderators/super users can delete things)
  saved.populateUserInfo(creatorUser);
  t.false(saved.userCanDelete, 'Creator cannot delete thing');

  // Other user should not be able to delete
  saved.populateUserInfo(otherUser);
  t.false(saved.userCanDelete, 'Other user cannot delete thing');

  // Unauthenticated user should not be able to delete
  saved.populateUserInfo(undefined);
  t.false(saved.userCanDelete, 'Unauthenticated user cannot delete thing');
});

test.serial('GET /:id/delete shows delete confirmation page for authorized user', async t => {
  const agent = supertest.agent(app);
  const username = `SiteMod-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  // Create the thing and also make the registered user a site moderator
  const { actor } = await dalFixture.createTestUser('ThingCreator');

  // Find the registered user and make them a site moderator
  const users = await User.filterWhere({ displayName: username }).run();
  if (users.length === 0) {
    return t.fail('Could not find registered user');
  }
  const siteMod = users[0];
  siteMod.isSiteModerator = true;
  await siteMod.save();

  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(actor, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Thing to Delete' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = actor.id;
  const saved = await thingRev.save();

  // Request delete page as site moderator
  const response = await agent.get(`/${saved.urlID}/delete`).expect(200);

  t.regex(
    response.text,
    /Proceed only if you are certain/i,
    'Delete confirmation page contains warning'
  );
  t.regex(response.text, /button.*delete/i, 'Delete confirmation page has delete button');
});

test.serial('GET /:id/delete denies access for unauthorized user', async t => {
  const agent = supertest.agent(app);
  const creatorUsername = `ThingCreator-${Date.now()}`;
  const otherUsername = `OtherUser-${Date.now()}`;

  // Create thing as one user
  const { actor: creator } = await dalFixture.createTestUser(creatorUsername);
  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Protected Thing' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  const saved = await thingRev.save();

  // Sign in as different user
  await registerTestUser(agent, {
    username: otherUsername,
    password: 'password123',
  });

  // Try to access delete page
  const response = await agent.get(`/${saved.urlID}/delete`).expect(403);

  t.regex(response.text, /permission/i, 'Shows permission error');
});

test.serial('POST /:id/delete successfully deletes thing for authorized user', async t => {
  const agent = supertest.agent(app);
  const username = `SiteMod-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  // Find the registered user and make them a site moderator
  const users = await User.filterWhere({ displayName: username }).run();
  if (users.length === 0) {
    return t.fail('Could not find registered user');
  }
  const siteMod = users[0];
  siteMod.isSiteModerator = true;
  await siteMod.save();

  // Create a thing
  const { actor } = await dalFixture.createTestUser('ThingCreator');
  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(actor, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Thing to Actually Delete' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = actor.id;
  const saved = await thingRev.save();
  const thingID = saved.id;

  // Get CSRF token
  const deletePageResponse = await agent.get(`/${saved.urlID}/delete`);
  const csrf = extractCSRF(deletePageResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token');
  }

  // Delete the thing as site moderator
  const response = await agent
    .post(`/${saved.urlID}/delete`)
    .type('form')
    .send({
      _csrf: csrf,
    })
    .expect(200);

  t.regex(response.text, /thing.*deleted/i, 'Shows deletion success message');

  // Verify thing is deleted in database
  const deletedThing = await Thing.get(thingID);
  t.true(deletedThing._data._rev_deleted, 'Thing is marked as deleted in database');
});

test.serial('POST /:id/delete denies deletion for unauthorized user', async t => {
  const agent = supertest.agent(app);
  const creatorUsername = `ThingCreator-${Date.now()}`;
  const otherUsername = `UnauthorizedDeleter-${Date.now()}`;

  // Create thing as one user
  const { actor: creator } = await dalFixture.createTestUser(creatorUsername);
  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Protected Thing for Deletion' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  const saved = await thingRev.save();
  const thingID = saved.id;

  // Sign in as different user
  await registerTestUser(agent, {
    username: otherUsername,
    password: 'password123',
  });

  // Get CSRF token (from own session)
  const newReviewResponse = await agent.get('/new/review');
  const csrf = extractCSRF(newReviewResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token');
  }

  // Try to delete the thing
  const response = await agent
    .post(`/${saved.urlID}/delete`)
    .type('form')
    .send({
      _csrf: csrf,
    })
    .expect(403);

  t.regex(response.text, /permission/i, 'Shows permission error');

  // Verify thing is NOT deleted in database
  const thing = await Thing.get(thingID);
  t.falsy(thing._data._rev_deleted, 'Thing is not deleted in database');
});

test.serial('GET and POST /:id/delete prevent deletion of thing with reviews', async t => {
  const agent = supertest.agent(app);
  const username = `SiteMod-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123',
  });

  // Find the registered user and make them a site moderator
  const users = await User.filterWhere({ displayName: username }).run();
  if (users.length === 0) {
    return t.fail('Could not find registered user');
  }
  const siteMod = users[0];
  siteMod.isSiteModerator = true;
  await siteMod.save();

  // Create a thing and a review for it
  const { actor: creator } = await dalFixture.createTestUser('ThingCreator');
  const url = `https://example.com/${randomUUID()}`;
  const thingRev = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thingRev.urls = [url];
  thingRev.label = { en: 'Thing with Review' };
  thingRev.originalLanguage = 'en';
  thingRev.createdOn = new Date();
  thingRev.createdBy = creator.id;
  const savedThing = await thingRev.save();
  const thingID = savedThing.id;

  // Create a review for this thing
  const Review = (await import('../models/review.ts')).default;
  const reviewRev = await Review.createFirstRevision(creator, { tags: ['create'] });
  reviewRev.thingID = thingID;
  reviewRev.title = { en: 'Test Review' };
  reviewRev.html = { en: '<p>Test review content</p>' };
  reviewRev.text = { en: 'Test review content' };
  reviewRev.starRating = 5;
  reviewRev.originalLanguage = 'en';
  reviewRev.createdOn = new Date();
  reviewRev.createdBy = creator.id;
  await reviewRev.save();

  // Try to access delete page - should redirect with error
  const getResponse = await agent.get(`/${savedThing.urlID}/delete`).expect(302);
  t.is(getResponse.headers.location, `/${savedThing.urlID}`, 'Redirects to thing page');

  // Try to POST delete - should also redirect with error
  const deletePageResponse = await agent.get(`/${savedThing.urlID}`);
  const csrf = extractCSRF(deletePageResponse.text);
  if (!csrf) {
    return t.fail('Could not obtain CSRF token');
  }

  const postResponse = await agent
    .post(`/${savedThing.urlID}/delete`)
    .type('form')
    .send({ _csrf: csrf })
    .expect(302);

  t.is(postResponse.headers.location, `/${savedThing.urlID}`, 'POST also redirects to thing page');

  // Verify thing is NOT deleted
  const finalThing = await Thing.get(thingID);
  t.falsy(finalThing._data._rev_deleted, 'Thing with review is not deleted');
});
