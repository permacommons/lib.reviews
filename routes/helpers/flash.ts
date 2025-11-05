// Adds two helper functions to flash middleware:
// - flashHas, to look up whether we have data for a given key in the flash
// - flashError, to store localized error messages in the flash
import type { NextFunction, Request, Response } from 'express';

import ReportedError from '../../util/reported-error.ts';
import debug from '../../util/debug.ts';

export default function flashMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.flashHas = (key: string) => {
    const flash = req.session?.flash;
    return Array.isArray(flash?.[key]) && (flash?.[key]?.length ?? 0) > 0;
  };

  // Add localized error message to pageErrors key, or log the error if
  // no such message is provided and display it as 'unknown error' to the
  // user. This is primarily used for form submissions.
  req.flashError = (error: unknown) => {
    if (error instanceof ReportedError) {
      const [message, ...params] = error.getEscapedUserMessageArray();
      if (message) {
        req.flash('pageErrors', req.__(message, ...params));
        return;
      }
    }

    req.flash('pageErrors', req.__('unknown error'));
    debug.error({
      req,
      error: error instanceof Error ? error : undefined,
    });
  };
  next();
}
