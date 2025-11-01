import { vsprintf } from 'sprintf-js';

/**
 * Configuration shared by {@link AbstractGenericError} subclasses.
 *
 * These options mirror the historical constructor contract from the
 * CommonJS implementation while making the formatting hooks explicit.
 */
export interface GenericErrorOptions {
  /** Message template (sprintf-compatible) used for the error. */
  message?: string;
  /** Parameters that will be interpolated into the formatted message. */
  messageParams?: unknown[] | unknown;
  /** Underlying error that triggered the current failure. */
  parentError?: Error;
  /** Additional structured data attached to the error instance. */
  payload?: Record<string, unknown>;
}

/**
 * Base class for rich error types that collect formatted messages from
 * subclasses while preserving the original stack and payload.
 */
export default abstract class AbstractGenericError extends Error {
  public readonly nativeMessage?: string;
  protected readonly nativeMessageParams: unknown[];
  public readonly parentError?: Error;
  public readonly payload: Record<string, unknown>;
  protected readonly messages: string[];

  /**
   * Constructs a new error instance, normalizing message parameters and
   * ensuring subclasses extend the abstract base properly.
   */
  protected constructor(options: GenericErrorOptions) {
    if (new.target === AbstractGenericError)
      throw new TypeError('AbstractGenericError is an abstract class, please instantiate a derived class.');

    if (!options || typeof options !== 'object')
      throw new Error('Need an options object for a GenericError.');

    super();

    const normalizedMessageParams = options.messageParams === undefined
      ? []
      : Array.isArray(options.messageParams)
        ? options.messageParams
        : [options.messageParams];

    this.nativeMessage = options.message;
    this.nativeMessageParams = normalizedMessageParams;
    this.parentError = options.parentError;
    this.payload = options.payload ? { ...options.payload } : {};

    this.name = this.constructor.name;
    this.messages = [];

    this.initializeMessages();
  }

  /**
   * Adds native and parent messages (if available) to the internal store so
   * subclasses can build a composite error summary.
   */
  protected initializeMessages(): void {
    if (this.nativeMessage)
      this.addMessage(vsprintf(this.nativeMessage, this.nativeMessageParams));

    if (this.parentError?.message)
      this.addMessage(`Original error message: ${this.parentError.message}`);
  }

  /** Stores a fully formatted message in the aggregation buffer. */
  protected addMessage(str: string): void {
    this.messages.push(str);
  }

  /** Dynamically formats the aggregate message from the internal store. */
  override get message(): string {
    return this.messages.join('\n');
  }
}
