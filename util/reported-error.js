import AbstractReportedError from './abstract-reported-error.js';
import i18n from 'i18n';
import sprintfJs from 'sprintf-js';

const { sprintf } = sprintfJs;

// For lib.reviews use, we use our standard i18n framework to log user errors
// in English
export default class ReportedError extends AbstractReportedError {
  constructor(options) {
    if (typeof options == 'object')
      options.translateFn = _translate;

    super(options);
  }
}

function _translate(...args) {
  try {
    return Reflect.apply(i18n.__, this, args);
  } catch (_e) {
    // In case i18n framework is not available or configured
    return Reflect.apply(sprintf, this, args);
  }
}
