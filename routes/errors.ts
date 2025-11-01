import type { Express, NextFunction, Request, Response } from 'express';

import render from './helpers/render.ts';
import debug from '../util/debug.ts';

type ErrorWithStatus = Error & { status?: number; type?: string };

class ErrorProvider {
  private readonly app: Express;

  constructor(app: Express) {
    this.app = app;
    // Bind 'this' so we can pass methods into middleware unmodified
    this.generic = this.generic.bind(this);
    this.notFound = this.notFound.bind(this);
    this.maintenanceMode = this.maintenanceMode.bind(this);
  }

  maintenanceMode(req: Request, res: Response) {
    if (req.path !== '/')
      return res.redirect('/');

    render.template(req, res, 'maintenance', {
      titleKey: 'maintenance mode'
    });
  }

  notFound(req: Request, res: Response) {
    // Trailing whitespace? Try again with trimmed URL before giving up
    if (/%20$/.test(req.originalUrl))
      return res.redirect(req.originalUrl.replace(/(.+?)(%20)+$/, '$1'));

    res.status(404);
    render.template(req, res, '404', {
      titleKey: 'page not found title'
    });
  }

  generic(error: ErrorWithStatus, req: Request, res: Response, _next: NextFunction) {
    /**
     * Fallback: handle DocumentNotFound errors as 404s if they weren't caught
     * by specific route handlers. Most routes should use
     * getResourceErrorHandler or getUserNotFoundHandler for better UX.
     */
    if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError')
      return this.notFound(req, res);

    const showDetails = this.app.get('env') === 'development' || Boolean(req.user?.showErrorDetails);

    res.status(error.status || 500);

    if (req.isAPI) {
      let response: { message: string; errors: string[] };
      switch (error.type || error.message) {
        case 'entity.parse.failed':
        case 'invalid json':
          response = {
            message: 'Could not process your request.',
            errors: ['Received invalid JSON data. Make sure your payload is in JSON format.']
          };
          break;
        default:
          response = {
            message: 'An error occurred processing your request.',
            errors: showDetails ? [error.message, `Stack: ${error.stack}`] : ['Unknown error. This has been logged.']
          };
          debug.error({ req, error });
      }
      res.type('json');
      res.send(JSON.stringify(response, null, 2));
    } else {
      debug.error({ req, error });
      render.template(req, res, 'error', {
        titleKey: 'something went wrong',
        showDetails,
        error
      });
    }
  }
}

export default ErrorProvider;
