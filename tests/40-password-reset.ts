import test from 'ava';
import config from 'config';
import { randomUUID } from 'crypto';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'password_reset',
  cleanupTables: ['password_reset_tokens', 'users', 'user_metas'],
});

let User;
let PasswordResetToken;

test.before(async () => {
  await bootstrapPromise;
  mockSearch();

  const { User: userModel, PasswordResetToken: tokenModel } = await dalFixture.initializeModels([
    { key: 'users', alias: 'User' },
    { key: 'password_reset_tokens', alias: 'PasswordResetToken' },
  ]);

  User = userModel;
  PasswordResetToken = tokenModel;
});

test.after.always(unmockSearch);

test.serial('PasswordResetToken.create generates valid token with expiration', async t => {
  const uniqueName = `ResetUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email, '192.168.1.1');

  t.truthy(token.id, 'Token has UUID');
  t.is(token.userID, user.id, 'Token references correct user');
  t.is(token.email, email, 'Token stores email');
  t.is(token.ipAddress, '192.168.1.1', 'Token stores IP address');
  t.truthy(token.createdAt, 'Token has creation timestamp');
  t.truthy(token.expiresAt, 'Token has expiration timestamp');
  t.falsy(token.usedAt, 'Token is initially unused');

  const expirationHours = config.get<number>('passwordReset.tokenExpirationHours') ?? 3;
  const expectedExpiration = token.createdAt.getTime() + expirationHours * 60 * 60 * 1000;
  t.true(
    Math.abs(token.expiresAt.getTime() - expectedExpiration) < 1000,
    'Token expires after configured duration'
  );
});

test.serial('PasswordResetToken.findByID retrieves token by UUID', async t => {
  const uniqueName = `FindUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  const found = await PasswordResetToken.findByID(token.id);

  t.truthy(found, 'Token found by ID');
  t.is(found.id, token.id, 'Retrieved token matches created token');
  t.is(found.email, email, 'Sensitive data (email) included');
});

test.serial('PasswordResetToken.findByID returns null for invalid input', async t => {
  const invalidUUID = await PasswordResetToken.findByID('not-a-uuid');
  t.is(invalidUUID, null, 'Returns null for invalid UUID');

  const nonExistent = await PasswordResetToken.findByID(randomUUID());
  t.is(nonExistent, null, 'Returns null for non-existent token');
});

test.serial('PasswordResetToken.isValid checks expiration and usage', async t => {
  const uniqueName = `ValidUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  t.true(token.isValid(), 'Fresh token is valid');

  // Manually expire the token
  token.expiresAt = new Date(Date.now() - 1000);
  t.false(token.isValid(), 'Expired token is invalid');
});

test.serial('PasswordResetToken.isValid returns false when token is used', async t => {
  const uniqueName = `UsedUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  t.true(token.isValid(), 'Token is valid before use');

  await token.markAsUsed();
  t.false(token.isValid(), 'Token is invalid after being used');
  t.truthy(token.usedAt, 'Token has usedAt timestamp');
});

test.serial('PasswordResetToken.markAsUsed sets usedAt timestamp', async t => {
  const uniqueName = `MarkUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  t.falsy(token.usedAt, 'Token initially has no usedAt');

  await token.markAsUsed();
  t.truthy(token.usedAt, 'Token has usedAt after marking');

  const retrieved = await PasswordResetToken.findByID(token.id);
  t.truthy(retrieved.usedAt, 'usedAt persisted to database');
});

test.serial('PasswordResetToken.getUser retrieves associated user', async t => {
  const uniqueName = `GetUserTest-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  const retrievedUser = await token.getUser();

  t.truthy(retrievedUser, 'User retrieved from token');
  t.is(retrievedUser.id, user.id, 'Retrieved user matches original');
  t.is(retrievedUser.displayName, uniqueName, 'User data is correct');
});

test.serial('PasswordResetToken.invalidateAllForUser marks all tokens as used', async t => {
  const uniqueName = `InvalidateUser-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  // Create multiple tokens for the same user
  const token1 = await PasswordResetToken.create(user.id, email);
  const token2 = await PasswordResetToken.create(user.id, email);
  const token3 = await PasswordResetToken.create(user.id, email);

  t.true(token1.isValid(), 'Token 1 initially valid');
  t.true(token2.isValid(), 'Token 2 initially valid');
  t.true(token3.isValid(), 'Token 3 initially valid');

  await PasswordResetToken.invalidateAllForUser(user.id);

  const retrieved1 = await PasswordResetToken.findByID(token1.id);
  const retrieved2 = await PasswordResetToken.findByID(token2.id);
  const retrieved3 = await PasswordResetToken.findByID(token3.id);

  t.false(retrieved1.isValid(), 'Token 1 invalidated');
  t.false(retrieved2.isValid(), 'Token 2 invalidated');
  t.false(retrieved3.isValid(), 'Token 3 invalidated');
  t.truthy(retrieved1.usedAt, 'Token 1 has usedAt');
  t.truthy(retrieved2.usedAt, 'Token 2 has usedAt');
  t.truthy(retrieved3.usedAt, 'Token 3 has usedAt');
});

test.serial('PasswordResetToken.hasRecentRequest detects cooldown period', async t => {
  const email = `cooldown-${randomUUID()}@example.com`;
  const cooldownHours = config.get<number>('passwordReset.cooldownHours') ?? 3;

  const hasRecentBefore = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
  t.false(hasRecentBefore, 'No recent request initially');

  // Create a user and token
  const uniqueName = `CooldownUser-${randomUUID()}`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  await PasswordResetToken.create(user.id, email);

  const hasRecentAfter = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
  t.true(hasRecentAfter, 'Recent request detected within cooldown');
});

test.serial('PasswordResetToken.hasRecentRequest ignores used tokens in cooldown', async t => {
  const email = `cooldown-used-${randomUUID()}@example.com`;
  const cooldownHours = config.get<number>('passwordReset.cooldownHours') ?? 3;

  const uniqueName = `CooldownUsedUser-${randomUUID()}`;
  const user = await User.create({
    name: uniqueName,
    password: 'secret123',
    email,
  });

  const token = await PasswordResetToken.create(user.id, email);
  await token.markAsUsed();

  const hasRecent = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
  t.false(hasRecent, 'Used tokens do not count toward cooldown');
});

test.serial(
  'PasswordResetToken.hasRecentRequest ignores tokens outside cooldown window',
  async t => {
    const email = `cooldown-expired-${randomUUID()}@example.com`;
    const cooldownHours = 0.0001; // Very short cooldown for testing

    const uniqueName = `CooldownExpiredUser-${randomUUID()}`;
    const user = await User.create({
      name: uniqueName,
      password: 'secret123',
      email,
    });

    await PasswordResetToken.create(user.id, email);

    // Wait for cooldown to expire (slightly longer than 0.0001 hours = ~0.36 seconds)
    await new Promise(resolve => setTimeout(resolve, 500));

    const hasRecent = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
    t.false(hasRecent, 'Old tokens outside cooldown window are ignored');
  }
);

test.serial('PasswordResetToken handles multiple users with same email', async t => {
  const sharedEmail = `shared-${randomUUID()}@example.com`;

  const user1 = await User.create({
    name: `User1-${randomUUID()}`,
    password: 'secret123',
    email: sharedEmail,
  });

  const user2 = await User.create({
    name: `User2-${randomUUID()}`,
    password: 'secret456',
    email: sharedEmail,
  });

  const token1 = await PasswordResetToken.create(user1.id, sharedEmail);
  const token2 = await PasswordResetToken.create(user2.id, sharedEmail);

  t.not(token1.id, token2.id, 'Different tokens generated');
  t.is(token1.email, token2.email, 'Both tokens have same email');
  t.not(token1.userID, token2.userID, 'Tokens reference different users');

  const retrievedUser1 = await token1.getUser();
  const retrievedUser2 = await token2.getUser();

  t.is(retrievedUser1.id, user1.id, 'Token 1 retrieves correct user');
  t.is(retrievedUser2.id, user2.id, 'Token 2 retrieves correct user');
});

test.serial('User.setPassword and password reset flow integration', async t => {
  const uniqueName = `PasswordChange-${randomUUID()}`;
  const email = `${uniqueName.toLowerCase()}@example.com`;
  const oldPassword = 'oldPassword123';
  const newPassword = 'newPassword456';

  const user = await User.create({
    name: uniqueName,
    password: oldPassword,
    email,
  });

  // Verify old password works
  const userWithPassword = await User.get(user.id, { includeSensitive: ['password'] });
  t.true(await userWithPassword.checkPassword(oldPassword), 'Old password valid');

  // Create reset token and change password
  const token = await PasswordResetToken.create(user.id, email);
  t.true(token.isValid(), 'Token is valid');

  await userWithPassword.setPassword(newPassword);
  await userWithPassword.save({ updateSensitive: ['password'] });
  await token.markAsUsed();

  // Verify password changed
  const updatedUser = await User.get(user.id, { includeSensitive: ['password'] });
  t.false(await updatedUser.checkPassword(oldPassword), 'Old password no longer works');
  t.true(await updatedUser.checkPassword(newPassword), 'New password works');
  t.false(token.isValid(), 'Token marked as used');
});
