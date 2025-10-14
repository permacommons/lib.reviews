'use strict';
const debugModule = require('debug');

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
        if (typeof error.req.body == 'object')
          log(JSON.stringify(error.req.body, null, 2));
        else
          log(error.req.body.toString());
      }
    }
    if (error && error.error) {
      log('Stacktrace:');
      log(error.error.stack);
    }
  }
};
module.exports = debug;
