/**
 * CSRF protection configuration using csrf-sync.
 * This module provides shared CSRF utilities for the application.
 *
 * @namespace CSRF
 */

import type { Request } from 'express';

import { csrfSync } from 'csrf-sync';

type CsrfToken = string | undefined;

const normalizeHeaderToken = (token: string | string[] | undefined): CsrfToken => {
  if (Array.isArray(token))
    return token[0];
  return token ?? undefined;
};

// Initialize CSRF protection with custom configuration to support both
// form submissions (body._csrf) and header-based submissions (x-csrf-token)
const {
  csrfSynchronisedProtection,
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError
} = csrfSync({
  getTokenFromRequest: (req: Request): CsrfToken => {
    const bodyToken = typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)._csrf
      : undefined;

    if (typeof bodyToken === 'string')
      return bodyToken;

    return normalizeHeaderToken(req.headers['x-csrf-token']);
  }
});

export {
  csrfSynchronisedProtection,
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError
};
