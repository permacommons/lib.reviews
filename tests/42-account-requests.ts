import { randomUUID } from 'node:crypto';
import test from 'ava';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'account_requests',
  cleanupTables: ['account_requests', 'users', 'user_metas', 'invite_links'],
});

let AccountRequest: any;

test.before(async () => {
  await bootstrapPromise;
  mockSearch();

  const { AccountRequest: accountRequestModel } = await dalFixture.initializeModels([
    { key: 'account_requests', alias: 'AccountRequest' },
  ]);

  AccountRequest = accountRequestModel;
});

test.after.always(unmockSearch);

test.serial('AccountRequest.createRequest stores pending request', async t => {
  const email = `User-${randomUUID()}@Example.com`;
  const request = await AccountRequest.createRequest({
    plannedReviews: 'Book reviews',
    languages: 'English, German',
    aboutLinks: 'https://example.com',
    email,
    termsAccepted: true,
    ipAddress: '127.0.0.1',
  });

  t.truthy(request.id);
  t.is(request.status, 'pending');
  t.is(request.email, email.toLowerCase());
  t.truthy(request.createdAt);
});

test.serial('AccountRequest.checkIPRateLimit enforces windowed limits', async t => {
  const ipAddress = '192.0.2.1';

  for (let i = 0; i < 3; i++) {
    await AccountRequest.createRequest({
      plannedReviews: `Test ${i}`,
      languages: 'English',
      aboutLinks: 'https://example.com',
      email: `ip-${i}-${randomUUID()}@example.com`,
      termsAccepted: true,
      ipAddress,
    });
  }

  const limitExceeded = await AccountRequest.checkIPRateLimit(ipAddress, 3, 24);
  t.true(limitExceeded);
});

test.serial('AccountRequest.hasRecentRequest detects cooldown by email', async t => {
  const email = `cooldown-${randomUUID()}@example.com`;

  await AccountRequest.createRequest({
    plannedReviews: 'Testing',
    languages: 'English',
    aboutLinks: 'https://example.com',
    email,
    termsAccepted: true,
  });

  const hasRecent = await AccountRequest.hasRecentRequest(email, 24);
  t.true(hasRecent);
});

test.serial('AccountRequest.getPending and getModerated return expected sets', async t => {
  const pending = await AccountRequest.createRequest({
    plannedReviews: 'Pending request',
    languages: 'English',
    aboutLinks: 'https://example.com',
    email: `pending-${randomUUID()}@example.com`,
    termsAccepted: true,
  });

  const approved = await AccountRequest.createRequest({
    plannedReviews: 'Will approve',
    languages: 'English',
    aboutLinks: 'https://example.com',
    email: `approved-${randomUUID()}@example.com`,
    termsAccepted: true,
  });
  approved.status = 'approved';
  approved.moderatedAt = new Date();
  await approved.save();

  const pendingRequests = await AccountRequest.getPending();
  const moderatedRequests = await AccountRequest.getModerated(10);

  t.true(pendingRequests.some((req: typeof pending) => req.id === pending.id));
  t.true(moderatedRequests.some((req: typeof approved) => req.id === approved.id));
});
