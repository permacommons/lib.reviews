import i18n from 'i18n';
import { sprintf } from 'sprintf-js';

import AbstractReportedError, { type ReportedErrorOptions } from './abstract-reported-error.ts';

/**
 * Reported error that defaults to lib.reviews' i18n translate function while
 * retaining the generic reporting utilities from the abstract base class.
 */
export default class ReportedError extends AbstractReportedError {
  constructor(options: ReportedErrorOptions) {
    if (options && typeof options === 'object') options.translateFn = _translate;

    super(options);
  }
}

/**
 * Attempts to translate a message using the shared i18n instance and falls
 * back to `sprintf` if localization data has not been bootstrapped yet.
 */
function _translate(this: unknown, ...args: unknown[]): string {
  try {
    return Reflect.apply(i18n.__, this, args);
  } catch (_e) {
    // In case i18n framework is not available or configured
    return Reflect.apply(sprintf, this, args);
  }
}
