import debugModule from 'debug';

const SENSITIVE_LOG_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'confirmPassword',
  'token',
  'accessToken'
]);

function sanitizeForLogging(value) {
  if (!value || typeof value != 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForLogging(item));
  }

  let sanitized = {};
  for (let [key, val] of Object.entries(value)) {
    if (SENSITIVE_LOG_KEYS.has(key)) {
      sanitized[key] = '<redacted>';
    } else {
      sanitized[key] = sanitizeForLogging(val);
    }
  }
  return sanitized;
}

/**
 * @namespace Debug
 */
const debug = {
  // For lower-level debug messages available if needed
  db: debugModule('libreviews:db'),
  app: debugModule('libreviews:app'),
  util: debugModule('libreviews:util'),
  tests: debugModule('libreviews:tests'),
  adapters: debugModule('libreviews:adapters'),
  webhooks: debugModule('libreviews:webhooks'),
  errorLog: debugModule('libreviews:error'), // for property access, use debug.error for logging


  /**
   * Log serious errors that should be examined. We support passing along
   * request info.
   *
   * @param  {(string|object)} error If a string, simply log it as such to
   *  `libreviews:error` via the `debug` module. If an object, we expect it
   *   to be of the form below.
   * @param {object} error.req - the Express request
   * @param {Error} error.error - the original error object
   * @memberof Debug
   */
  error(error) {
    if (typeof error == 'string') {
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
      if (typeof error.req.body == 'object') {
        log(JSON.stringify(sanitizeForLogging(error.req.body), null, 2));
      } else {
        log('<omitted>');
      }
      }
    }
    if (error && error.error) {
      log('Stacktrace:');
      log(error.error.stack);
    }
  }
};

export default debug;
