import type { NextFunction, Response } from 'express';
import type { Session, SessionData } from 'express-session';
import type { Request } from 'express-serve-static-core';

/** Storage map keyed by message type to an array of payloads. */
type FlashBucket = Record<string, unknown[]>;

type FlashSession = (Session & Partial<SessionData>) & { flash?: FlashBucket };

type FlashRequest = Request & {
  session?: FlashSession;
  flash?: (key: string, value?: unknown) => unknown[];
};

/**
 * Express middleware that mimics `req.flash` from `connect-flash` while using
 * the session object already present in the application.
 */
export default function flashStore(req: FlashRequest, _res: Response, next: NextFunction): void {
  if (!req || typeof req !== 'object')
    throw new TypeError('Express request object is required for flash storage.');

  if (!req.session) {
    next(new Error('Flash storage requires session middleware to be registered before it.'));
    return;
  }

  const flashImpl = (key: string, value?: unknown): unknown[] => {
    if (!key)
      throw new TypeError('Flash key is required');

    const session = req.session as FlashSession;

    if (value === undefined) {
      const store = session.flash;
      if (!store)
        return [];

      const messages = Array.isArray(store[key]) ? [...store[key]] : [];
      delete store[key];

      if (Object.keys(store).length === 0)
        Reflect.deleteProperty(session, 'flash');

      return messages;
    }

    if (!session.flash)
      session.flash = Object.create(null);

    if (!Array.isArray(session.flash[key]))
      session.flash[key] = [];

    session.flash[key].push(value);
    return session.flash[key];
  };

  req.flash = flashImpl as unknown as FlashRequest['flash'];

  next();
}
