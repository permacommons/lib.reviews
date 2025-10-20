import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { createDALFixtureAVA } from './fixtures/dal-fixture-ava.mjs';

const require = createRequire(import.meta.url);

// Standard env settings for AVA worker
process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-3';
if (!process.env.LIBREVIEWS_SKIP_RETHINK) {
  process.env.LIBREVIEWS_SKIP_RETHINK = '1';
}

const dalFixture = createDALFixtureAVA('testing-3', { tableSuffix: 'user_file_models' });

let User;
let File;
let NewUserError;

test.before(async t => {
  try {
    await dalFixture.bootstrap();

    // Ensure UUID generation helper exists (ignore failures on hosted CI)
    try {
      await dalFixture.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    } catch (extensionError) {
      t.log('pgcrypto extension not available:', extensionError.message);
    }

    const { users, files } = await dalFixture.initializeModels([
      {
        key: 'users',
        loader: dal => require('../models-postgres/user').initializeUserModel(dal)
      },
      {
        key: 'files',
        loader: dal => require('../models-postgres/file').initializeFileModel(dal)
      }
    ]);

    User = users;
    File = files;
    ({ NewUserError } = require('../models-postgres/user'));
  } catch (error) {
    t.log('PostgreSQL not available, skipping PostgreSQL model tests:', error.message);
    t.pass('Skipping tests - PostgreSQL not configured');
  }
});

test.beforeEach(async () => {
  await dalFixture.cleanupTables(['files', 'users']);
});

test.after.always(async () => {
  await dalFixture.cleanup();
});

function skipIfNoModels(t) {
  if (!User || !File) {
    t.pass('Skipping - PostgreSQL DAL not available');
    return true;
  }
  return false;
}

test.serial('User model: create hashes password and canonicalizes name', async t => {
  if (skipIfNoModels(t)) return;

  const uniqueName = `TestUser-${randomUUID()}`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email: `${uniqueName.toLowerCase()}@example.com`
  });

  t.truthy(user.id, 'User persisted with generated UUID');
  t.is(user.display_name, uniqueName, 'Display name stored');
  t.is(user.canonical_name, uniqueName.toUpperCase(), 'Canonical name uppercases input');
  t.true(user.password.startsWith('$2b$'), 'Password stored as bcrypt hash');
});

test.serial('User model: ensureUnique rejects duplicate usernames', async t => {
  if (skipIfNoModels(t)) return;

  const name = `Duplicate-${randomUUID()}`;
  await User.create({
    name,
    password: 'secret123',
    email: `${name.toLowerCase()}@example.com`
  });

  const error = await t.throwsAsync(() => User.create({
    name,
    password: 'different123',
    email: `${name.toLowerCase()}+other@example.com`
  }));

  t.true(error instanceof NewUserError);
  t.is(error.userMessage, 'username exists');
});

test.serial('User model: checkPassword validates bcrypt hash', async t => {
  if (skipIfNoModels(t)) return;

  const name = `Password-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'supersecret';

  const user = await User.create({ name, password, email });
  const storedUser = await User.get(user.id);

  t.true(await storedUser.checkPassword(password), 'Correct password matches hash');
  t.false(await storedUser.checkPassword('incorrect'), 'Wrong password fails');
});

test.serial('User model: increaseInviteLinkCount increments atomically', async t => {
  if (skipIfNoModels(t)) return;

  const name = `Invites-${randomUUID()}`;
  const user = await User.create({
    name,
    password: 'secret123',
    email: `${name.toLowerCase()}@example.com`
  });

  const first = await User.increaseInviteLinkCount(user.id);
  const second = await User.increaseInviteLinkCount(user.id);

  t.is(first, 1);
  t.is(second, 2);

  const reloaded = await User.get(user.id);
  t.is(reloaded.invite_link_count, 2, 'Invite count persisted');
});

test.serial('File model: create first revision and retrieve stashed upload', async t => {
  if (skipIfNoModels(t)) return;

  const uploaderName = `Uploader-${randomUUID()}`;
  const uploader = await User.create({
    name: uploaderName,
    password: 'secret123',
    email: `${uploaderName.toLowerCase()}@example.com`
  });

  const draft = await File.createFirstRevision(uploader, { tags: ['upload'] });
  draft.name = 'example.png';
  draft.uploaded_by = uploader.id;
  draft.uploaded_on = new Date();
  draft.mime_type = 'image/png';
  draft.license = 'cc-by';
  draft.description = { en: 'Sample description' };
  draft.creator = { en: 'Sample Creator' };
  draft.source = { en: 'https://example.com/source' };

  const saved = await draft.save();
  t.truthy(saved.id, 'Draft saved with ID');
  t.false(saved.completed, 'Draft uploads start incomplete');

  const stashed = await File.getStashedUpload(uploader.id, 'example.png');
  t.truthy(stashed, 'Stashed upload retrieved');
  t.is(stashed.uploaded_by, uploader.id);

  stashed.completed = true;
  await stashed.save();

  const afterComplete = await File.getStashedUpload(uploader.id, 'example.png');
  t.is(afterComplete, undefined, 'Completed uploads no longer count as stashed');
});

test.serial('File model: populateUserInfo reflects permissions', async t => {
  if (skipIfNoModels(t)) return;

  const uploaderName = `Perms-${randomUUID()}`;
  const otherName = `Viewer-${randomUUID()}`;

  const uploader = await User.create({
    name: uploaderName,
    password: 'secret123',
    email: `${uploaderName.toLowerCase()}@example.com`
  });

  const moderator = await User.create({
    name: otherName,
    password: 'secret123',
    email: `${otherName.toLowerCase()}@example.com`
  });
  moderator.is_site_moderator = true;
  await moderator.save();

  const draft = await File.createFirstRevision(uploader, { tags: ['upload'] });
  draft.name = 'permissions.txt';
  draft.uploaded_by = uploader.id;
  draft.uploaded_on = new Date();
  draft.mime_type = 'text/plain';
  draft.license = 'cc-0';
  const file = await draft.save();

  file.populateUserInfo(uploader);
  t.true(file.user_is_creator, 'Uploader is creator');
  t.true(file.user_can_delete, 'Uploader can delete');

  const viewer = await File.get(file.id);
  viewer.populateUserInfo(moderator);
  t.false(viewer.user_is_creator, 'Moderator is not creator');
  t.true(viewer.user_can_delete, 'Moderator can delete via elevated role');
});
