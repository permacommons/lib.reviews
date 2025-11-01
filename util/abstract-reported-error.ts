import escapeHTML from 'escape-html';
import { sprintf } from 'sprintf-js';

import AbstractGenericError, { type GenericErrorOptions } from './abstract-generic-error.js';

/**
 * Translation function signature compatible with `sprintf` and i18n helpers.
 */
export type TranslateFn = (this: unknown, messageKey: string, ...params: unknown[]) => string;

/** Options accepted by {@link AbstractReportedError}. */
export interface ReportedErrorOptions extends GenericErrorOptions {
  /** i18n key or literal string visible to end users. */
  userMessage?: string;
  /** Parameters interpolated into the localized user message. */
  userMessageParams?: unknown[] | unknown;
  /** Formatter used to render the localized user message. */
  translateFn?: TranslateFn;
}

/**
 * Base class for errors that expose a localized message alongside the
 * developer-focused stack trace and payload.
 */
export default abstract class AbstractReportedError extends AbstractGenericError {
  protected readonly translateFn: TranslateFn;
  protected readonly userMessage?: string;
  protected readonly userMessageParams: unknown[];
  public locale: string;

  /**
   * Builds an error with optional localized messaging and translation hooks.
   */
  protected constructor(options: ReportedErrorOptions) {
    if (new.target === AbstractReportedError)
      throw new TypeError('AbstractReportedError is an abstract class, please instantiate a derived class.');

    if (!options || typeof options !== 'object')
      throw new Error('Need an options object for a ReportedError.');

    super(options);

    this.userMessage = options.userMessage;

    const normalized = options.userMessageParams === undefined
      ? this.nativeMessageParams
      : Array.isArray(options.userMessageParams)
        ? options.userMessageParams
        : [options.userMessageParams];

    this.userMessageParams = normalized;
    this.translateFn = options.translateFn || sprintf;

    // Locale used for "Messages displayed to the user:" section of traces
    this.locale = 'en';

    this.initializeUserMessage();
  }

  /** Adds an English fallback user message to the aggregate message stack. */
  protected initializeUserMessage(): void {
    if (this.userMessage) {
      const args: unknown[] = [this.userMessage, ...this.userMessageParams];
      this.addMessage('Message displayed to the user: ' + Reflect.apply(this.translateFn, this, args));
    }
  }

  /** Escapes interpolated values so UI layers can safely render the message. */
  getEscapedUserMessageArray(): (string | undefined)[] {
    return [this.userMessage, ...this.userMessageParams.map(param => escapeHTML(String(param)))];
  }
}
