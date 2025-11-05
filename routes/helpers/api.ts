import type { NextFunction, Request, Response } from 'express';

type ErrorPayload = string | string[] | Record<string, unknown>[] | undefined;

/**
 * Set the API flag for API requests and ensure write operations originate
 * from trusted callers. Accepts either XMLHttpRequest or the native app
 * identifier in the X-Requested-With header before allowing mutation.
 */
const prepareRequest = (req: Request, res: Response, next: NextFunction) => {
  req.isAPI = true;

  const requestedWith = req.get('x-requested-with');
  const isReadMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  if (!isReadMethod && requestedWith !== 'XMLHttpRequest' && requestedWith !== 'app') {
    const response = {
      message: 'Access denied.',
      errors: [
        'Missing X-Requested-With header. Must be set to "XMLHttpRequest" or "app" to avoid request forgery.',
      ],
    };
    res.status(400);
    res.type('json');
    res.send(JSON.stringify(response, null, 2));
    return;
  }

  if (isReadMethod) res.set('Access-Control-Allow-Origin', '*');

  next();
};

const signinRequired = (_req: Request, res: Response) => {
  const response = {
    message: 'Could not perform action.',
    errors: ['Authentication required.'],
  };
  res.type('json');
  res.status(401);
  res.send(JSON.stringify(response, null, 2));
};

/**
 * Send one or more error messages for API callers. Accepts a single string or
 * array of strings and defaults to HTTP 400 when no status is provided.
 */
const error = (_req: Request, res: Response, errors: ErrorPayload, status = 400) => {
  const formattedErrors = Array.isArray(errors)
    ? errors
    : errors === undefined
      ? ['Unspecified error.']
      : [errors];
  res.type('json');
  res.status(status);
  res.send({
    message: 'Could not perform action.',
    errors: formattedErrors,
  });
};

const api = {
  prepareRequest,
  signinRequired,
  error,
};

export type ApiHelper = typeof api;
export default api;
