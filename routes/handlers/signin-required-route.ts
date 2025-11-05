import render from '../helpers/render.ts';
import type { HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';

// A simple middleware wrapper that handles aborting routes that require a user
// to be logged in, and renders an appropriate error page with the given
// titleKey. Note the titleKey is stored as a local for further response
// processing.
type RouteFunction<TArgs extends unknown[]> = (
  req: HandlerRequest,
  res: HandlerResponse,
  ...args: TArgs
) => unknown;

export default function signinRequiredRoute<TArgs extends unknown[]>(
  titleKey: string,
  routeFn: RouteFunction<TArgs>
): RouteFunction<TArgs> {
  return (req, res, ...args) => {
    if (!req.user)
      return render.signinRequired(req, res, {
        titleKey,
      });
    res.locals.titleKey = titleKey;
    routeFn(req, res, ...args);
  };
}
