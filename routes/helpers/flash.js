// Adds two helper functions to flash middleware:
// - flashHas, to look up whether we have data for a given key in the flash
// - flashError, to store localized error messages in the flash
import ReportedError from '../../util/reported-error.js';
import debug from '../../util/debug.js';

export default function flashMiddleware(req, res, next) {
  req.flashHas = key => {
    const flash = req.session && req.session.flash;
    return Array.isArray(flash?.[key]) && flash[key].length > 0;
  };

  // Add localized error message to pageErrors key, or log the error if
  // no such message is provided and display it as 'unknown error' to the
  // user. This is primarily used for form submissions.
  req.flashError = error => {
    if (error instanceof ReportedError && error.userMessage) {
      req.flash('pageErrors', Reflect.apply(req.__, this, error.getEscapedUserMessageArray()));
    } else {
      req.flash('pageErrors', req.__('unknown error'));
      debug.error({ req, error });
    }
  };
  next();
}
