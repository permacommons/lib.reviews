import escapeHTML from 'escape-html';

import render from '../helpers/render.ts';
import type { HandlerRequest, HandlerResponse, HandlerNext } from '../../types/http/handlers.ts';

type ResourceError = {
  name?: string;
  message?: string;
};

// Generic handler for 404s, missing revisions or old revisions (when we don't
// want them!).
export default function getResourceErrorHandler(
  req: HandlerRequest,
  res: HandlerResponse,
  next: HandlerNext,
  messageKeyPrefix: string,
  bodyParam: string
): (error: ResourceError) => void {
  if (!messageKeyPrefix || !bodyParam)
    throw new Error(
      'We need a prefix for message keys, and a parameter containing e.g. the ID of the resource.'
    );

  const escapedBodyParam = escapeHTML(bodyParam);

  return function (error: ResourceError) {
    switch (error?.name) {
      // In "not found" case, we also attempt to redirect any URL with trailing
      // whitespace (some number of '%20's at the end) to its canonical version.
      case 'DocumentNotFound':
      case 'DocumentNotFoundError':
        if (/%20$/.test(req.originalUrl))
          return res.redirect(req.originalUrl.replace(/(.+?)(%20)+$/, '$1'));
      // falls through
      case 'RevisionDeletedError':
        res.status(404);
        render.resourceError(req, res, {
          titleKey: `${messageKeyPrefix} not found title`,
          bodyKey: `${messageKeyPrefix} not found`,
          bodyParam: escapedBodyParam,
        });
        break;
      case 'InvalidUUIDError':
        res.status(404);
        render.resourceError(req, res, {
          titleKey: `${messageKeyPrefix} address invalid title`,
          bodyKey: `${messageKeyPrefix} address invalid`,
          bodyParam: escapedBodyParam,
        });
        break;
      case 'RevisionStaleError':
        res.status(403);
        render.resourceError(req, res, {
          titleKey: 'stale revision error title',
          bodyKey: 'stale revision error',
          bodyParam: escapedBodyParam,
        });
        break;
      case 'RedirectedError':
        break;
      default:
        return next(error);
    }
  };
}
