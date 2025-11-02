import test from 'ava';
import { randomUUID } from 'crypto';
import passport from 'passport';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

import { mockSearch, unmockSearch } from './helpers/mock-search.ts';

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
  ({ NewUserError } = await import('../models/user.ts'));
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
  })) as any;

  t.true(error instanceof NewUserError);
  t.is(error.userMessage, 'username exists');
});

test.serial('User model: checkPassword validates bcrypt hash', async t => {

  const name = `Password-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'supersecret';

  const user = await User.create({ name, password, email });
  const storedUser = await User.get(user.id, { includeSensitive: ['password'] });

  t.true(await storedUser.checkPassword(password), 'Correct password matches hash');
  t.false(await storedUser.checkPassword('incorrect'), 'Wrong password fails');
});

test.serial('User model: account without password is treated as locked', async t => {

  const name = `LockedAccount-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'secret123';

  // Create a user normally with a password
  const user = await User.create({ name, password, email });
  const userId = user.id;

  // Load user with password and remove it (simulating a locked account)
  const userToLock = await User.get(userId, { includeSensitive: ['password'] });
  userToLock.password = null;
  await userToLock.save({ updateSensitive: ['password'] });

  // Verify password was cleared
  const lockedUser = await User.get(userId, { includeSensitive: ['password'] });
  t.is(lockedUser.password, null, 'Password is null for locked account');

  // Verify authentication fails with locked account message
  // We need to test through the auth strategy
  await import('../auth.ts');

  const authenticatePromise = new Promise<{ error: unknown; user: unknown; info: { message?: string } | undefined }>((resolve) => {
    const strategy = (passport as any)._strategy('local');
    strategy._verify(name, 'anypassword', (error: unknown, user: unknown, info: { message?: string } | undefined) => {
      resolve({ error, user, info });
    });
  });

  const result = await authenticatePromise;
  t.falsy(result.error, 'No error thrown');
  t.falsy(result.user, 'Authentication failed');
  t.is(result.info.message, 'account locked', 'Correct locked account message');
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

test.serial('User model: password preserved when updating user field without loading sensitive fields', async t => {
  const name = `PasswordPreserve-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'supersecret123';

  // Create user with password
  const user = await User.create({ name, password, email });
  const userId = user.id;

  // Load user WITHOUT sensitive fields (default behavior)
  const userWithoutPassword = await User.get(userId);
  t.false(userWithoutPassword._data.hasOwnProperty('password'), 'Password not loaded in _data');

  // Update a non-sensitive field
  userWithoutPassword.isTrusted = true;
  await userWithoutPassword.save();

  // Reload user with password and verify it's still set
  const reloadedUser = await User.get(userId, { includeSensitive: ['password'] });
  t.truthy(reloadedUser.password, 'Password still exists after update');
  t.true(await reloadedUser.checkPassword(password), 'Original password still validates');
  t.true(reloadedUser.isTrusted, 'Update to non-sensitive field was saved');
});

test.serial('User model: password preserved during bio creation flow', async t => {
  const name = `BioPassword-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'secretbio123';

  // Create user with password
  const user = await User.create({ name, password, email });
  const userId = user.id;

  // Load user WITHOUT sensitive fields (simulating the bio edit flow)
  const userForBioEdit = await User.findByURLName(user.urlName, { withData: true });
  t.false(userForBioEdit._data.hasOwnProperty('password'), 'Password not loaded during bio edit');

  const bio = {
    bio: {
      text: { en: 'My new bio' },
      html: { en: '<p>My new bio</p>' }
    },
    originalLanguage: 'en'
  };

  // Create bio (this triggers user.save() internally)
  await User.createBio(userForBioEdit, bio);

  // Verify password is still intact
  const reloadedUser = await User.get(userId, { includeSensitive: ['password'] });
  t.truthy(reloadedUser.password, 'Password still exists after createBio');
  t.true(await reloadedUser.checkPassword(password), 'Original password still validates after createBio');

  // Verify bio was created by loading with metadata
  const userWithMeta = await User.findByURLName(name, { withData: true });
  t.truthy(userWithMeta.meta, 'Bio was created');
  t.is(userWithMeta.meta.bio.text.en, 'My new bio', 'Bio content is correct');
});

test.serial('User model: in-place JSONB modification is detected and saved', async t => {
  const name = `JsonbEdit-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'secret123';

  // Create user with bio
  const user = await User.create({ name, password, email });
  const bio = {
    bio: {
      text: { en: 'Original bio text' },
      html: { en: '<p>Original bio text</p>' }
    },
    originalLanguage: 'en'
  };
  await User.createBio(user, bio);

  // Load user with metadata
  const userWithMeta = await User.findByURLName(name, { withData: true });
  t.is(userWithMeta.meta.bio.text.en, 'Original bio text', 'Original bio loaded');

  // Modify bio in-place (not reassigning the whole object)
  userWithMeta.meta.bio.text.en = 'Updated bio text';
  userWithMeta.meta.bio.html.en = '<p>Updated bio text</p>';
  userWithMeta.meta.bio.text.es = 'Texto actualizado';
  userWithMeta.meta.bio.html.es = '<p>Texto actualizado</p>';

  // Save the changes
  await userWithMeta.meta.save();

  // Reload and verify changes persisted
  const reloadedUser = await User.findByURLName(name, { withData: true });
  t.is(reloadedUser.meta.bio.text.en, 'Updated bio text', 'English bio update persisted');
  t.is(reloadedUser.meta.bio.html.en, '<p>Updated bio text</p>', 'English HTML update persisted');
  t.is(reloadedUser.meta.bio.text.es, 'Texto actualizado', 'Spanish bio added');
  t.is(reloadedUser.meta.bio.html.es, '<p>Texto actualizado</p>', 'Spanish HTML added');
});

test.serial('User model: unchanged JSONB fields are not marked dirty during save', async t => {
  const name = `UnchangedJsonb-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const password = 'secret123';

  // Create user with bio
  const user = await User.create({ name, password, email });
  const bio = {
    bio: {
      text: { en: 'Bio text', es: 'Texto biográfico' },
      html: { en: '<p>Bio text</p>', es: '<p>Texto biográfico</p>' }
    },
    originalLanguage: 'en'
  };
  await User.createBio(user, bio);

  // Load user with metadata
  const userWithMeta = await User.findByURLName(name, { withData: true });

  // Simulate save prep steps without any modifications
  // The _changed set should be empty since nothing was modified
  userWithMeta.meta._detectInPlaceChanges();
  userWithMeta.meta._validate();
  t.is(userWithMeta.meta._changed.size, 0, 'No fields marked as changed when nothing modified');

  // Now modify only originalLanguage (not the bio JSONB field)
  userWithMeta.meta.originalLanguage = 'es';
  userWithMeta.meta._detectInPlaceChanges();
  userWithMeta.meta._validate();

  // Only originalLanguage should be in _changed, not bio
  t.true(userWithMeta.meta._changed.has('original_language'), 'Modified field is in _changed');
  t.false(userWithMeta.meta._changed.has('bio'), 'Unchanged JSONB field not in _changed');
  t.is(userWithMeta.meta._changed.size, 1, 'Only one field marked as changed');
});

test.serial('User model: password can be updated with updateSensitive option', async t => {
  const name = `PasswordUpdate-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const oldPassword = 'oldpassword123';
  const newPassword = 'newpassword456';

  // Create user with initial password
  const user = await User.create({ name, password: oldPassword, email });
  const userId = user.id;

  // Load user with password and change it
  const userToUpdate = await User.get(userId, { includeSensitive: ['password'] });
  await userToUpdate.setPassword(newPassword);

  // Save with explicit permission to update sensitive field
  await userToUpdate.save({ updateSensitive: ['password'] });

  // Verify new password works and old one doesn't
  const verifyUser = await User.get(userId, { includeSensitive: ['password'] });
  t.true(await verifyUser.checkPassword(newPassword), 'New password validates');
  t.false(await verifyUser.checkPassword(oldPassword), 'Old password no longer validates');
});

test.serial('User model: password update blocked without updateSensitive option', async t => {
  const name = `PasswordBlock-${randomUUID()}`;
  const email = `${name.toLowerCase()}@example.com`;
  const originalPassword = 'originalpass123';

  // Create user
  const user = await User.create({ name, password: originalPassword, email });
  const userId = user.id;

  // Load user with password, change it, but don't allow update
  const userToUpdate = await User.get(userId, { includeSensitive: ['password'] });
  const oldHash = userToUpdate.password;
  await userToUpdate.setPassword('attemptednewpass');

  // Also change a non-sensitive field
  userToUpdate.isTrusted = true;

  // Save WITHOUT updateSensitive - password change should be ignored
  await userToUpdate.save();

  // Verify password unchanged but other field updated
  const verifyUser = await User.get(userId, { includeSensitive: ['password'] });
  t.is(verifyUser.password, oldHash, 'Password hash unchanged');
  t.true(await verifyUser.checkPassword(originalPassword), 'Original password still validates');
  t.true(verifyUser.isTrusted, 'Non-sensitive field was updated');
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
