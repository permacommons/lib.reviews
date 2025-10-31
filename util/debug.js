'use strict';
const debugModule = require('debug');

const SENSITIVE_LOG_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken'
]);

function sanitizeForLogging(value) {
  if (!value || typeof value !== 'object')
    return value;

  if (Array.isArray(value))
    return value.map(item => sanitizeForLogging(item));

  let sanitized = {};
  for (let [key, val] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_LOG_KEYS.has(key) ? '<redacted>' : sanitizeForLogging(val);
  }
  return sanitized;
}

const debug = {
  db: debugModule('libreviews:db'),
  app: debugModule('libreviews:app'),
  util: debugModule('libreviews:util'),
  tests: debugModule('libreviews:tests'),
  adapters: debugModule('libreviews:adapters'),
  webhooks: debugModule('libreviews:webhooks'),
  errorLog: debugModule('libreviews:error'),

  error(error) {
    if (typeof error === 'string') {
      this.errorLog(error);
      return;
    }

    const log = this.errorLog;
    if (error && error.req) {
      if (error.req.route)
        log(`Error occurred in route <${error.req.route.path}>.`);

      log(`Request method: ${error.req.method} - URL: ${error.req.originalUrl}`);
      if (error.req.method !== 'GET' && error.req.body !== undefined) {
        log('Request body:');
        if (typeof error.req.body === 'object')
          log(JSON.stringify(sanitizeForLogging(error.req.body), null, 2));
        else
          log('<omitted>');
      }
    }
    if (error && error.error) {
      log('Stacktrace:');
      log(error.error.stack);
    }
  }
};

module.exports = debug;
