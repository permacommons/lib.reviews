import test from 'ava';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { setupPostgresTest } from './helpers/setup-postgres-test.mjs';

import { mockSearch, unmockSearch } from './helpers/mock-search.mjs';

const require = createRequire(import.meta.url);

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'user_file_models',
  cleanupTables: ['files', 'users', 'user_metas']
});

let User;
let File;
let NewUserError;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const { User: userModel, File: fileModel } = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'files', alias: 'File' }
  ]);

  User = userModel;
  File = fileModel;
  ({ NewUserError } = require('../models/user'));
});

test.after.always(unmockSearch);

test.serial('User model: create hashes password and canonicalizes name', async t => {

  const uniqueName = `TestUser-${randomUUID()}`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email: `${uniqueName.toLowerCase()}@example.com`
  });

  t.truthy(user.id, 'User persisted with generated UUID');
  t.is(user.displayName, uniqueName, 'Display name stored');
  t.is(user.canonicalName, uniqueName.toUpperCase(), 'Canonical name uppercases input');
  t.true(user.password.startsWith('$2b$'), 'Password stored as bcrypt hash');
});

test.serial('User model: ensureUnique rejects duplicate usernames', async t => {

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

  const name = `Password-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'supersecret';

  const user = await User.create({ name, password, email });
  const storedUser = await User.get(user.id);

  t.true(await storedUser.checkPassword(password), 'Correct password matches hash');
  t.false(await storedUser.checkPassword('incorrect'), 'Wrong password fails');
});

test.serial('User model: increaseInviteLinkCount increments atomically', async t => {

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
  t.is(reloaded.inviteLinkCount, 2, 'Invite count persisted');
});

test.serial('User model: findByURLName loads metadata and teams safely', async t => {

  const name = `Bio-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'secret123';

  const user = await User.create({ name, password, email });

  const bio = {
    bio: {
      text: { en: 'Test bio' },
      html: { en: '<p>Test bio</p>' }
    },
    originalLanguage: 'en'
  };

  await User.createBio(user, bio);

  const fetched = await User.findByURLName(user.urlName, {
    withData: true,
    withTeams: true
  });

  t.truthy(fetched.meta, 'Metadata attached to fetched user');
  t.is(fetched.meta.bio.text.en, 'Test bio', 'Bio text persisted and loaded');
  t.true(Array.isArray(fetched.teams), 'Teams list provided');
  t.true(Array.isArray(fetched.moderatorOf), 'Moderator list provided');
});

test.serial('File model: create first revision and retrieve stashed upload', async t => {

  const uploaderName = `Uploader-${randomUUID()}`;
  const uploader = await User.create({
    name: uploaderName,
    password: 'secret123',
    email: `${uploaderName.toLowerCase()}@example.com`
  });

  const draft = await File.createFirstRevision(uploader, { tags: ['upload'] });
  draft.name = 'example.png';
  draft.uploadedBy = uploader.id;
  draft.uploadedOn = new Date();
  draft.mimeType = 'image/png';
  draft.license = 'cc-by';
  draft.description = { en: 'Sample description' };
  draft.creator = { en: 'Sample Creator' };
  draft.source = { en: 'https://example.com/source' };

  const saved = await draft.save();
  t.truthy(saved.id, 'Draft saved with ID');
  t.false(saved.completed, 'Draft uploads start incomplete');

  const stashed = await File.getStashedUpload(uploader.id, 'example.png');
  t.truthy(stashed, 'Stashed upload retrieved');
  t.is(stashed.uploadedBy, uploader.id);

  stashed.completed = true;
  await stashed.save();

  const afterComplete = await File.getStashedUpload(uploader.id, 'example.png');
  t.is(afterComplete, undefined, 'Completed uploads no longer count as stashed');
});

test.serial('File model: populateUserInfo reflects permissions', async t => {

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
  moderator.isSiteModerator = true;
  await moderator.save();

  const draft = await File.createFirstRevision(uploader, { tags: ['upload'] });
  draft.name = 'permissions.txt';
  draft.uploadedBy = uploader.id;
  draft.uploadedOn = new Date();
  draft.mimeType = 'text/plain';
  draft.license = 'cc-0';
  const file = await draft.save();

  file.populateUserInfo(uploader);
  t.true(file.userIsCreator, 'Uploader is creator');
  t.true(file.userCanDelete, 'Uploader can delete');

  const viewer = await File.get(file.id);
  viewer.populateUserInfo(moderator);
  t.false(viewer.userIsCreator, 'Moderator is not creator');
  t.true(viewer.userCanDelete, 'Moderator can delete via elevated role');
});

test.after.always(async () => {
  await dalFixture.cleanup();
});
