/**
 * CSRF protection configuration using csrf-csrf's Double Submit Cookie pattern.
 * This module provides shared CSRF utilities for the application.
 *
 * @namespace CSRF
 */

import crypto from 'node:crypto';
import config from 'config';
import { doubleCsrf } from 'csrf-csrf';
import type { NextFunction, Request, Response } from 'express';

type CsrfToken = string | undefined;

const normalizeHeaderToken = (token: string | string[] | undefined): CsrfToken => {
  if (Array.isArray(token)) return token[0];
  return token ?? undefined;
};

const csrfTokenCookieName = 'libreviews_csrf';
const csrfIdentifierCookieName = 'libreviews_csrf_id';

const cookieMaxAgeMs = (() => {
  const minutes = config.get('sessionCookieDuration');
  if (typeof minutes !== 'number') return undefined;
  return minutes * 1000 * 60;
})();

const shouldUseSecureCookies = (() => {
  const httpsEnabled = config.get('https.enabled');
  return typeof httpsEnabled === 'boolean' ? httpsEnabled : false;
})();

const getCookieValue = (req: Request, name: string): string | undefined => {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length ? value : undefined;
};

const getTokenFromRequest = (req: Request): CsrfToken => {
  const bodyToken =
    typeof req.body === 'object' && req.body !== null
      ? (req.body as Record<string, unknown>)._csrf
      : undefined;

  if (typeof bodyToken === 'string') return bodyToken;

  return normalizeHeaderToken(req.headers['x-csrf-token']);
};

const isMultipartRequest = (req: Request): boolean =>
  typeof req.headers['content-type'] === 'string' &&
  req.headers['content-type'].startsWith('multipart/form-data');

const ensureCsrfIdentifierCookie = (req: Request, res: Response): void => {
  const existing = getCookieValue(req, csrfIdentifierCookieName);
  if (existing) return;

  const value = crypto.randomBytes(16).toString('hex');
  res.cookie(csrfIdentifierCookieName, value, {
    maxAge: cookieMaxAgeMs,
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies,
  });

  const cookies = (req.cookies ?? {}) as Record<string, unknown>;
  cookies[csrfIdentifierCookieName] = value;
  (req as Request & { cookies: Record<string, unknown> }).cookies = cookies;
};

const csrf = doubleCsrf({
  getSecret: () => config.get('sessionSecret'),
  getSessionIdentifier: req => {
    const id = getCookieValue(req, csrfIdentifierCookieName);
    if (!id) throw new Error('CSRF identifier cookie missing');
    return id;
  },
  cookieName: csrfTokenCookieName,
  cookieOptions: {
    maxAge: cookieMaxAgeMs,
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies,
  },
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getCsrfTokenFromRequest: req => getTokenFromRequest(req),
  skipCsrfProtection: req => isMultipartRequest(req),
});

const { invalidCsrfTokenError } = csrf;

/**
 * Validate CSRF for the current request using the Double Submit Cookie pattern.
 *
 * This checks that a CSRF token (submitted via `body._csrf` or `x-csrf-token`) matches
 * the CSRF token cookie (`libreviews_csrf`) for the same requester, keyed by a separate,
 * httpOnly identifier cookie (`libreviews_csrf_id`).
 *
 * Multipart form requests are intentionally not validated here because Multer populates
 * `req.body` after it has processed the stream. For uploads we validate CSRF after Multer
 * has run (see `routes/uploads.ts`).
 */
const validateRequest = (req: Request): boolean => csrf.validateRequest(req);

const csrfSynchronisedProtection = (req: Request, res: Response, next: NextFunction): void => {
  ensureCsrfIdentifierCookie(req, res);
  req.csrfToken = options => csrf.generateCsrfToken(req, res, options);
  csrf.doubleCsrfProtection(req, res, next);
};

const generateToken = (req: Request): string => {
  if (!req.csrfToken) throw new Error('CSRF middleware has not been initialized.');
  return req.csrfToken();
};

const getTokenFromState = (req: Request): CsrfToken => getCookieValue(req, csrfTokenCookieName);

export {
  csrfSynchronisedProtection,
  generateToken,
  getTokenFromRequest,
  getTokenFromState,
  invalidCsrfTokenError,
  validateRequest,
};
