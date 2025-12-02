import nock from 'nock';

const MAILGUN_HOST = 'https://api.mailgun.net';

interface MailgunMockOptions {
  domain?: string;
  fromEmail?: string;
  responseStatus?: number;
  responseBody?: unknown;
}

/**
 * Mock successful Mailgun message creation
 */
export function mockMailgunMessageSuccess(options: MailgunMockOptions = {}) {
  const domain = options.domain || 'mg.example.com';
  const responseStatus = options.responseStatus || 200;
  const responseBody = options.responseBody || {
    id: '<20240101000000.1.1234@mg.example.com>',
    message: 'Queued. Thank you.',
  };

  return nock(MAILGUN_HOST).post(`/v3/${domain}/messages`).reply(responseStatus, responseBody);
}

/**
 * Mock Mailgun message creation failure
 */
export function mockMailgunMessageFailure(options: MailgunMockOptions = {}) {
  const domain = options.domain || 'mg.example.com';
  const responseStatus = options.responseStatus || 400;
  const responseBody = options.responseBody || {
    message: 'Invalid request',
  };

  return nock(MAILGUN_HOST).post(`/v3/${domain}/messages`).reply(responseStatus, responseBody);
}

/**
 * Mock Mailgun domain list (used for config testing)
 */
export function mockMailgunDomainList(options: MailgunMockOptions = {}) {
  const responseStatus = options.responseStatus || 200;
  const responseBody = options.responseBody || {
    items: [
      {
        name: 'mg.example.com',
        state: 'active',
      },
    ],
  };

  return nock(MAILGUN_HOST).get('/v3/domains').reply(responseStatus, responseBody);
}

/**
 * Mock Mailgun domain list failure (used for config testing)
 */
export function mockMailgunDomainListFailure(options: MailgunMockOptions = {}) {
  const responseStatus = options.responseStatus || 401;
  const responseBody = options.responseBody || {
    message: 'Unauthorized',
  };

  return nock(MAILGUN_HOST).get('/v3/domains').reply(responseStatus, responseBody);
}

/**
 * Clean up all Mailgun mocks
 */
export function cleanupMailgunMocks() {
  nock.cleanAll();
}

/**
 * Check if there are pending Mailgun mocks
 */
export function hasPendingMailgunMocks(): boolean {
  return !nock.isDone();
}
