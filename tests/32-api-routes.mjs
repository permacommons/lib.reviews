import test from 'ava';
import supertest from 'supertest';
import isUUID from 'is-uuid';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { registerTestUser } from './helpers/integration-helpers.mjs';
import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const uploadsDir = path.join(projectRoot, 'static/uploads');

mockSearch();

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'api_routes',
  cleanupTables: [
    'reviews',
    'things',
    'files',
    'users'
  ]
});

let User, Thing, Review, File;
let app;

test.before(async () => {
  await bootstrapPromise;

  const models = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
    { key: 'files', alias: 'File' }
  ]);

  User = models.User;
  Thing = models.Thing;
  Review = models.Review;
  File = models.File;

  const config = require('config');
  await fs.mkdir(config.uploadTempDir, { recursive: true });

  Reflect.deleteProperty(require.cache, require.resolve('../app'));
  const getApp = require('../app');
  app = await getApp();
});

// ============================================================================
// GET /api/user/:name - User Information Retrieval
// ============================================================================

test.serial('GET /api/user/:name returns user information for existing user', async t => {

  const agent = supertest.agent(app);
  const username = `APITestUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const urlName = username.replace(/ /g, '_');
  const response = await agent
    .get(`/api/user/${urlName}`)
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.truthy(body.id);
  t.true(isUUID.v4(body.id));
  t.is(body.displayName, username);
  t.is(body.canonicalName, User.canonicalize(username));
  t.truthy(body.registrationDate);
  t.is(body.isSiteModerator, false);
  t.pass();
});

test.serial('GET /api/user/:name returns 404 for non-existent user', async t => {

  const response = await supertest(app)
    .get('/api/user/NonExistentUser12345')
    .expect(404)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.is(body.message, 'Could not retrieve user data.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.includes('User does not exist.'));
  t.pass();
});

// ============================================================================
// GET /api/thing?url=<url> - Thing (Review Subject) Lookup
// ============================================================================

test.serial('GET /api/thing?url=<url> returns thing data with review metrics', async t => {

  const agent = supertest.agent(app);
  const username = `ThingCreator-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const urlName = username.replace(/ /g, '_');
  const user = await User.findByURLName(urlName, { withPassword: true });

  // Create a thing with a review
  const userActor = { id: user.id, is_super_user: user.isSuperUser, is_trusted: user.isTrusted };
  const thingRev = await Thing.createFirstRevision(userActor, { tags: ['create'] });
  thingRev.urls = ['https://example.com/test-product'];
  thingRev.label = { en: 'Test Product' };
  thingRev.description = { en: 'A test product for API testing' };
  thingRev.createdBy = user.id;
  thingRev.createdOn = new Date();
  const thing = await thingRev.save();

  const reviewRev = await Review.createFirstRevision(userActor, { tags: ['create'] });
  reviewRev.thingID = thing.id;
  reviewRev.title = { en: 'Great product' };
  reviewRev.text = { en: 'This is a test review' };
  reviewRev.html = { en: '<p>This is a test review</p>' };
  reviewRev.starRating = 4;
  reviewRev.createdBy = user.id;
  reviewRev.createdOn = new Date();
  const review = await reviewRev.save();

  const response = await agent
    .get('/api/thing?url=https://example.com/test-product')
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.truthy(body.thing);
  t.true(isUUID.v4(body.thing.id));
  t.deepEqual(body.thing.label, { en: 'Test Product' });
  // Description is returned in metadata, not as a top-level field
  t.truthy(body.thing.urls);
  t.is(body.thing.numberOfReviews, 1);
  t.is(body.thing.averageStarRating, 4);
  t.pass();
});

test.serial('GET /api/thing?url=<url> returns 404 for non-existent URL', async t => {

  const response = await supertest(app)
    .get('/api/thing?url=https://example.com/does-not-exist-12345')
    .expect(404)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.is(body.message, 'Could not retrieve review subject.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.includes('URL not found.'));
  t.pass();
});

test.serial('GET /api/thing?url=<url> returns 400 for invalid URL', async t => {

  const response = await supertest(app)
    .get('/api/thing?url=not-a-valid-url')
    .expect(400)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.is(body.message, 'Could not retrieve review subject.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.includes('URL is not valid.'));
  t.pass();
});

// ============================================================================
// GET /api/suggest/thing/:prefix - Search Suggestions
// ============================================================================

test.serial('GET /api/suggest/thing/:prefix returns search suggestions', async t => {

  // The mock search will return results for any prefix
  const response = await supertest(app)
    .get('/api/suggest/thing/test')
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.truthy(body.results);
  // Mock search should return structured results
  t.pass();
});

test.serial('GET /api/suggest/thing/:prefix handles whitespace prefix', async t => {

  const response = await supertest(app)
    .get('/api/suggest/thing/%20')
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.truthy(body.results);
  t.pass();
});

// ============================================================================
// POST /api/actions/modify-preference - User Preference Management
// ============================================================================

test.serial('POST /api/actions/enable-preference enables a user preference', async t => {

  const agent = supertest.agent(app);
  const username = `PrefUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const response = await agent
    .post('/api/actions/enable-preference')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('json')
    .send({ preferenceName: 'prefersRichTextEditor' })
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.truthy(body.message);
  t.true(['Preference not altered.', 'Preference changed.'].includes(body.message));
  t.is(body.newValue, 'true');
  t.deepEqual(body.errors, []);
  t.pass();
});

test.serial('POST /api/actions/toggle-preference toggles a user preference', async t => {

  const agent = supertest.agent(app);
  const username = `ToggleUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  // First toggle
  const response1 = await agent
    .post('/api/actions/toggle-preference')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('json')
    .send({ preferenceName: 'prefersRichTextEditor' })
    .expect(200)
    .expect('Content-Type', /json/);

  const body1 = response1.body;
  t.is(body1.message, 'Preference changed.');
  const firstValue = body1.newValue;

  // Second toggle
  const response2 = await agent
    .post('/api/actions/toggle-preference')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('json')
    .send({ preferenceName: 'prefersRichTextEditor' })
    .expect(200)
    .expect('Content-Type', /json/);

  const body2 = response2.body;
  t.is(body2.message, 'Preference changed.');
  t.not(body2.newValue, firstValue, 'Value should toggle');
  t.pass();
});

test.serial('POST /api/actions/modify-preference requires authentication', async t => {

  const response = await supertest(app)
    .post('/api/actions/enable-preference')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ preferenceName: 'prefersRichTextEditor' })
    .expect(401);

  t.pass();
});

test.serial('POST /api/actions/modify-preference rejects invalid preference names', async t => {

  const agent = supertest.agent(app);
  const username = `InvalidPrefUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const response = await agent
    .post('/api/actions/enable-preference')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ preferenceName: 'invalidPreferenceName' })
    .expect(400)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.is(body.message, 'Could not perform action.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.some(e => e.includes('Unknown preference')));
  t.pass();
});

// ============================================================================
// POST /api/actions/suppress-notice - Notice Suppression
// ============================================================================

test.serial('POST /api/actions/suppress-notice suppresses a valid notice type', async t => {

  const agent = supertest.agent(app);
  const username = `NoticeUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const urlName = username.replace(/ /g, '_');
  let user = await User.findByURLName(urlName, { withPassword: true });
  t.falsy(user.suppressedNotices, 'User should not have suppressed notices initially');

  const response = await agent
    .post('/api/actions/suppress-notice')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ noticeType: 'language-notice-review' })
    .expect(200)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.regex(body.message, /Success.*will no longer be shown/);
  t.deepEqual(body.errors, []);

  // Verify it was actually saved
  user = await User.findByURLName(urlName, { withPassword: true });
  t.true(Array.isArray(user.suppressedNotices));
  t.true(user.suppressedNotices.includes('language-notice-review'));
  t.pass();
});

test.serial('POST /api/actions/suppress-notice handles duplicate suppression', async t => {

  const agent = supertest.agent(app);
  const username = `DuplicateNoticeUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const urlName = username.replace(/ /g, '_');

  // Suppress once
  await agent
    .post('/api/actions/suppress-notice')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ noticeType: 'language-notice-thing' })
    .expect(200);

  // Suppress again
  await agent
    .post('/api/actions/suppress-notice')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ noticeType: 'language-notice-thing' })
    .expect(200);

  // Verify only one entry exists
  const user = await User.findByURLName(urlName, { withPassword: true });
  const count = user.suppressedNotices.filter(n => n === 'language-notice-thing').length;
  t.is(count, 1, 'Should not have duplicate entries');
  t.pass();
});

test.serial('POST /api/actions/suppress-notice rejects invalid notice types', async t => {

  const agent = supertest.agent(app);
  const username = `InvalidNoticeUser-${Date.now()}`;
  await registerTestUser(agent, {
    username,
    password: 'password123'
  });

  const response = await agent
    .post('/api/actions/suppress-notice')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ noticeType: 'invalid-notice-type' })
    .expect(400)
    .expect('Content-Type', /json/);

  const body = response.body;
  t.is(body.message, 'The request could not be processed.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.some(e => e.includes('was not recognized')));
  t.pass();
});

test.serial('POST /api/actions/suppress-notice requires authentication', async t => {

  const response = await supertest(app)
    .post('/api/actions/suppress-notice')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ noticeType: 'language-notice-review' })
    .expect(401);

  t.pass();
});

// ============================================================================
// POST /api/actions/upload - File Upload
// ============================================================================

test.serial('POST /api/actions/upload successfully uploads a valid file', async t => {

  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64'
  );

  const uploadAgent = supertest.agent(app);
  const username = `Uploader ${Date.now()}`;
  await registerTestUser(uploadAgent, {
    username,
    password: 'uploadRocks!'
  });

  const urlName = username.replace(/ /g, '_');
  const uploader = await User.findByURLName(urlName, { withPassword: true });
  uploader.isTrusted = true;
  await uploader.save();

  let uploadedPath;
  let savedFile;

  try {
    const response = await uploadAgent
      .post('/api/actions/upload')
      .set('x-requested-with', 'XMLHttpRequest')
      .field('description', 'Tiny PNG')
      .field('license', 'cc-by')
      .field('ownwork', 'true')
      .field('language', 'en')
      .attach('files', pngBuffer, {
        filename: 'tiny.png',
        contentType: 'image/png'
      });

    t.is(response.status, 200, `Upload failed: ${response.status} ${response.text}`);
    t.true(/json/.test(response.headers['content-type']), 'Response should be JSON');

    const body = Object.keys(response.body || {}).length ? response.body : JSON.parse(response.text);

    t.is(body.message, 'Upload successful.');
    t.deepEqual(body.errors, []);
    t.true(Array.isArray(body.uploads));
    t.is(body.uploads.length, 1);

    const uploaded = body.uploads[0];
    t.truthy(uploaded.fileID);
    t.is(uploaded.originalName, 'tiny.png');
    t.is(uploaded.license, 'cc-by');
    t.deepEqual(uploaded.description, { en: 'Tiny PNG' });

    uploadedPath = path.join(uploadsDir, uploaded.uploadedFileName);
    const stats = await fs.stat(uploadedPath);
    t.true(stats.size > 0, 'Uploaded file should exist on disk.');

    savedFile = await File.get(uploaded.fileID);
    t.true(savedFile.completed, 'Saved file metadata should be marked completed.');
    t.is(savedFile.mimeType, 'image/png');
    t.is(savedFile.license, 'cc-by');
    t.is(savedFile.uploadedBy, uploader.id);
    t.deepEqual(savedFile.description, { en: 'Tiny PNG' });
  } finally {
    if (savedFile) {
      await savedFile.deleteAllRevisions().catch(() => {});
    }
    if (uploadedPath) {
      await fs.unlink(uploadedPath).catch(() => {});
    }
  }
});

test.serial('POST /api/actions/upload rejects files with unrecognized signature', async t => {

  const uploadAgent = supertest.agent(app);
  const username = `Uploader ${Date.now()} invalid`;
  await registerTestUser(uploadAgent, {
    username,
    password: 'uploadFails!'
  });

  const urlName = username.replace(/ /g, '_');
  const uploader = await User.findByURLName(urlName, { withPassword: true });
  uploader.isTrusted = true;
  await uploader.save();

  const bogusBuffer = Buffer.from('definitely not an image');

  const response = await uploadAgent
    .post('/api/actions/upload')
    .set('x-requested-with', 'XMLHttpRequest')
    .field('description', 'Bogus file')
    .field('license', 'cc-by')
    .field('ownwork', 'true')
    .field('language', 'en')
    .attach('files', bogusBuffer, {
      filename: 'fake.png',
      contentType: 'image/png'
    });

  t.is(response.status, 400, `Expected upload to be rejected, got ${response.status}`);

  const body = Object.keys(response.body || {}).length ? response.body : JSON.parse(response.text);
  t.is(body.message, 'Could not perform action.');
  t.true(Array.isArray(body.errors) && body.errors.length > 0, 'Expected error details in response');

  const [errorDetail] = body.errors;
  t.truthy(errorDetail.internalMessage);
  t.true(
    (errorDetail.displayMessage || '').includes('did not recognize the file type'),
    `Unexpected display message: ${errorDetail.displayMessage}`
  );

  const savedFiles = await File.filter({ uploadedBy: uploader.id });
  t.is(savedFiles.length, 0, 'No file records should be persisted for rejected uploads');
});

test.serial('POST /api/actions/upload requires authentication', async t => {

  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64'
  );

  const response = await supertest(app)
    .post('/api/actions/upload')
    .set('x-requested-with', 'XMLHttpRequest')
    .field('description', 'Tiny PNG')
    .field('license', 'cc-by')
    .field('ownwork', 'true')
    .field('language', 'en')
    .attach('files', pngBuffer, {
      filename: 'tiny.png',
      contentType: 'image/png'
    })
    .expect(401);

  t.pass();
});

test.serial('POST /api/actions/upload requires trusted user permission', async t => {

  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
    'base64'
  );

  const uploadAgent = supertest.agent(app);
  const username = `UntrustedUploader ${Date.now()}`;
  await registerTestUser(uploadAgent, {
    username,
    password: 'uploadFails!'
  });

  // Don't set isTrusted - user should not have upload permission
  const response = await uploadAgent
    .post('/api/actions/upload')
    .set('x-requested-with', 'XMLHttpRequest')
    .field('description', 'Tiny PNG')
    .field('license', 'cc-by')
    .field('ownwork', 'true')
    .field('language', 'en')
    .attach('files', pngBuffer, {
      filename: 'tiny.png',
      contentType: 'image/png'
    })
    .expect(400);

  const body = Object.keys(response.body || {}).length ? response.body : JSON.parse(response.text);
  t.is(body.message, 'Could not perform action.');
  t.true(Array.isArray(body.errors));
  t.true(body.errors.some(e => e.includes('not permitted to upload')));
  t.pass();
});

test.after.always(async () => {
  unmockSearch();
  await dalFixture.cleanup();
});
