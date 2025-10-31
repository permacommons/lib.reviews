import sprintfJs from 'sprintf-js';

const { vsprintf } = sprintfJs;

// Class for custom errors with support for sprintf and inherited messages
export default class AbstractGenericError extends Error {
  constructor(options) {

    if (new.target === AbstractGenericError)
      throw new TypeError('AbstractGenericError is an abstract class, please instantiate a derived class.');

    if (typeof options !== 'object')
      throw new Error('Need an options object for a GenericError.');

    super();

    // For convenience, don't mess up if we get a single parameter which isn't
    // in array form
    if (options.messageParams && !Array.isArray(options.messageParams))
      options.messageParams = [options.messageParams];

    this.nativeMessage = options.message;
    this.nativeMessageParams = options.messageParams || [];

    // We can link this error to the parent error which triggered it
    this.parentError = options.parentError;

    // We can associate a payload (data, metadata, etc.) with any given error
    this.payload = options.payload || {};

    this.name = this.constructor.name;

    this.messages = [];

    this.initializeMessages();

  }

  // Add native and parent messages, if any, to the store
  initializeMessages() {
    if (this.nativeMessage)
      this.addMessage(vsprintf(this.nativeMessage, this.nativeMessageParams));

    if (this.parentError && this.parentError.message)
      this.addMessage(`Original error message: ${this.parentError.message}`);
  }

  // Add a fully formatted string to the message store
  addMessage(str) {
    this.messages.push(str);
  }

  // Dynamically constructed so subclasses can add to the internal message store
  get message() {

    return this.messages.join('\n');

  }

}
