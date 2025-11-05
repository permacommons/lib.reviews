/**
 * Utility helpers for working with date values throughout the application.
 * These helpers keep runtime behaviour consistent while providing
 * type-friendly signatures for the TypeScript migration.
 */

/** Accepted inputs for the date helper functions. */
export type DateInput = Date | string | number | null | undefined;

/**
 * Coerces a loose value into a valid Date or returns null.
 *
 * @param input Value that may represent a date (Date, string, or millisecond timestamp)
 * @returns Coerced Date instance when valid, otherwise null
 */
function coerceDate(input: DateInput): Date | null {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return input;
  }

  if (typeof input === 'number' && Number.isFinite(input)) {
    const fromNumber = new Date(input);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof input === 'string' && input.trim().length) {
    const fromString = new Date(input);
    return Number.isNaN(fromString.getTime()) ? null : fromString;
  }

  return null;
}

/** Calls a `Date` formatter with optional locale handling. */
function formatWithLocale(
  date: Date,
  locale: string | undefined,
  formatter: (this: Date, ...args: unknown[]) => string
): string | undefined {
  if (!date) return undefined;

  try {
    return locale ? formatter.call(date, locale) : formatter.call(date);
  } catch {
    return formatter.call(date);
  }
}

/**
 * Formats a value into a locale-aware short date string.
 *
 * @param value Value to format as a date
 * @param locale Optional locale override used for formatting
 * @returns Locale-formatted short date string, or undefined if the input is invalid
 */
function formatShortDate(value: DateInput, locale?: string): string | undefined {
  const date = coerceDate(value);
  if (!date) return undefined;
  return formatWithLocale(date, locale, Date.prototype.toLocaleDateString);
}

/**
 * Formats a value into a locale-aware long date string.
 *
 * @param value Value to format as a date and time
 * @param locale Optional locale override used for formatting
 * @returns Locale-formatted long date string, or undefined if the input is invalid
 */
function formatLongDate(value: DateInput, locale?: string): string | undefined {
  const date = coerceDate(value);
  if (!date) return undefined;
  return formatWithLocale(date, locale, Date.prototype.toLocaleString);
}

/**
 * Formats a value into an ISO 8601 string if it represents a valid date.
 *
 * @param value Value to format as an ISO 8601 string
 * @returns ISO 8601 string representation, or undefined if the input is invalid
 */
function formatISODate(value: DateInput): string | undefined {
  const date = coerceDate(value);
  return date ? date.toISOString() : undefined;
}

/**
 * Returns true when the input can be converted into a valid Date.
 *
 * @param value Value to test for date validity
 * @returns Whether the value can be coerced into a valid Date
 */
function isValidDateValue(value: DateInput): boolean {
  return coerceDate(value) !== null;
}

export { coerceDate, formatISODate, formatLongDate, formatShortDate, isValidDateValue };
