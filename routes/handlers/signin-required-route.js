import render from '../helpers/render.ts';

// A simple middleware wrapper that handles aborting routes that require a user
// to be logged in, and renders an appropriate error page with the given
// titleKey. Note the titleKey is stored as a local for further response
// processing.
export default function signinRequiredRoute(titleKey, routeFn) {
  return (req, res, ...args) => {
    if (!req.user)
      return render.signinRequired(req, res, {
        titleKey
      });
    res.locals.titleKey = titleKey;
    routeFn(req, res, ...args);
  };
}
