import escapeHTML from 'escape-html';
import AbstractGenericError from './abstract-generic-error.mjs';
import sprintfJs from 'sprintf-js';

const { sprintf } = sprintfJs;

// Class for custom errors which can be reported out to the user as localized messages
export default class AbstractReportedError extends AbstractGenericError {
  constructor(options) {
    if (new.target === AbstractReportedError)
      throw new TypeError('AbstractReportedError is an abstract class, please instantiate a derived class.');

    if (typeof options !== 'object')
      throw new Error('Need an options object for a ReportedError.');

    super(options);

    // Message key
    this.userMessage = options.userMessage;

    // For convenience, don't mess up if we get a single parameter which isn't
    // in array form
    if (options.userMessageParams && !Array.isArray(options.userMessageParams))
      options.userMessageParams = [options.userMessageParams];

    // Array of parameters that can be substituted into the message
    this.userMessageParams = options.userMessageParams || this.nativeMessageParams;

    // For logging purposes, we display the user message alongside the native
    // error message (if any). To do so, we may need to look up message keys
    // through an i18n framework. If provided, translateFn is called with
    // the message key and the sequence of message parameters as individual
    // arguments. If not provided, we sprintf the user message + parameters.
    this.translateFn = options.translateFn || sprintf;

    // Locale used for "Messages displayed to the user:" section of traces
    this.locale = 'en';

    this.initializeUserMessage();

  }

  // Add English messages to messages stack for internal reporting
  initializeUserMessage() {
    if (this.userMessage) {
      let arr = [this.userMessage].concat(this.userMessageParams);
      this.addMessage('Message displayed to the user: ' + Reflect.apply(this.translateFn, this, arr));
    }
  }

  // Array which can be processed by i18n framework
  getEscapedUserMessageArray() {
    return [this.userMessage].concat(this.userMessageParams.map(escapeHTML));
  }

}
