'use strict';

/**
 * CSRF protection configuration using csrf-sync.
 * This module provides shared CSRF utilities for the application.
 *
 * @namespace CSRF
 */

const { csrfSync } = require('csrf-sync');

// Initialize CSRF protection with custom configuration to support both
// form submissions (body._csrf) and header-based submissions (x-csrf-token)
const {
  csrfSynchronisedProtection,
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError
} = csrfSync({
  getTokenFromRequest: (req) => {
    // Check form body first (for traditional form submissions)
    if (req.body && req.body._csrf) {
      return req.body._csrf;
    }
    // Fall back to header (for AJAX/API requests)
    return req.headers['x-csrf-token'];
  }
});

module.exports = {
  csrfSynchronisedProtection,
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError
};
