import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'ava';
import { randomUUID } from 'crypto';
import { formatMailgunError } from '../util/email.ts';

// Test the formatMailgunError function with various error types
test.serial('formatMailgunError handles Mailgun API errors', t => {
  const mailgunError = {
    status: 400,
    message: 'Invalid domain',
    details: 'Domain not found in account',
  };

  const formatted = formatMailgunError(mailgunError);
  t.true(formatted.includes('MailgunAPIError'), 'Identifies as Mailgun error');
  t.true(formatted.includes('status=400'), 'Includes status');
  t.true(formatted.includes('Invalid domain'), 'Includes message');
  t.true(formatted.includes('details=Domain not found'), 'Includes details');
});

test.serial('formatMailgunError handles standard Error objects', t => {
  const error = new Error('Network timeout');
  error.stack = 'Error: Network timeout\n    at ...';

  const formatted = formatMailgunError(error);
  t.true(formatted.includes('Error: Network timeout'), 'Includes error message');
  t.true(formatted.includes('stack='), 'Includes stack trace');
});

test.serial('formatMailgunError handles network errors with error codes', t => {
  const error = new Error('Network error');
  // Simulate a network error with a code (like ECONNRESET) but no status
  // This avoids triggering the Mailgun API error path
  Object.assign(error, { code: 'ECONNRESET' });

  const formatted = formatMailgunError(error);
  t.true(formatted.includes('Error: Network error'), 'Includes error message');
  t.true(formatted.includes('code=ECONNRESET'), 'Includes error code');
});

test.serial('formatMailgunError handles plain objects', t => {
  const error = { custom: 'error', value: 123 };
  const formatted = formatMailgunError(error);
  t.true(formatted.includes('custom'), 'Serializes object');
  t.true(formatted.includes('123'), 'Includes values');
});

test.serial('formatMailgunError handles primitive values', t => {
  t.is(formatMailgunError('string error'), 'string error', 'Handles strings');
  t.is(formatMailgunError(42), '42', 'Handles numbers');
  t.is(formatMailgunError(null), 'null', 'Handles null');
});

// Test email template system
test.serial('English email templates exist (fallback language)', async t => {
  const textPath = path.resolve(process.cwd(), 'views/email/password-reset-en.txt');
  const htmlPath = path.resolve(process.cwd(), 'views/email/password-reset-en.hbs');

  await t.notThrowsAsync(fs.access(textPath), 'English text template exists');
  await t.notThrowsAsync(fs.access(htmlPath), 'English HTML template exists');
});

test.serial('Email text template has correct structure', async t => {
  const textPath = path.resolve(process.cwd(), 'views/email/password-reset-en.txt');
  const content = await fs.readFile(textPath, 'utf-8');

  t.true(content.startsWith('Subject:'), 'Text template starts with Subject line');
  t.true(content.includes('{{resetURL}}'), 'Contains resetURL placeholder');
  t.true(content.includes('{{expirationHours}}'), 'Contains expirationHours placeholder');
});

test.serial('Email HTML template has correct structure', async t => {
  const htmlPath = path.resolve(process.cwd(), 'views/email/password-reset-en.hbs');
  const content = await fs.readFile(htmlPath, 'utf-8');

  t.true(content.includes('<!doctype html>'), 'HTML template has doctype');
  t.true(content.includes('{{resetURL}}'), 'Contains resetURL placeholder');
  t.true(content.includes('{{expirationHours}}'), 'Contains expirationHours placeholder');
  t.true(content.includes('<a href="{{resetURL}}">'), 'Reset URL is in a link');
});

// Test template variable substitution logic
test.serial('Template substitution replaces variables and handles edge cases', t => {
  // Basic substitution
  const basic = 'Hello {{name}}!'.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const vars: Record<string, string> = { name: 'World' };
    return vars[key] ?? '';
  });
  t.is(basic, 'Hello World!', 'Basic variable substitution works');

  // Multiple variables with different types
  const complex = 'URL: {{resetURL}}, expires in {{expirationHours}} hours'.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => {
      const vars: Record<string, string | number> = {
        resetURL: 'https://example.com/reset/abc123',
        expirationHours: 3,
      };
      const value = vars[key];
      return value === undefined ? '' : String(value);
    }
  );
  t.true(complex.includes('https://example.com/reset/abc123'), 'URL substituted');
  t.true(complex.includes('3 hours'), 'Number converted to string');

  // Missing variables become empty strings
  const missing = 'Hello {{name}}, your {{item}} is ready'.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const vars: Record<string, string> = { name: 'Alice' };
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
  t.is(missing, 'Hello Alice, your  is ready', 'Missing variables become empty strings');
});

// Test URL construction logic
test.serial('Reset URL construction builds valid URLs', t => {
  const token = randomUUID();

  // Basic HTTPS URL
  const httpsURL = new URL(`reset-password/${token}`, 'https://lib.reviews').toString();
  t.true(httpsURL.startsWith('https://lib.reviews/reset-password/'), 'URL has correct base');
  t.true(httpsURL.includes(token), 'URL includes token');
  t.regex(
    httpsURL,
    /^https:\/\/lib\.reviews\/reset-password\/[0-9a-f-]{36}$/,
    'URL matches expected format'
  );

  // Handles trailing slash correctly
  const trailingSlash = new URL(`reset-password/${token}`, 'https://lib.reviews/').toString();
  t.false(trailingSlash.includes('//reset-password'), 'Trailing slash normalized correctly');
});
