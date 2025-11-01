/**
 * Utility helpers for working with date values throughout the application.
 * These helpers keep runtime behaviour consistent while providing
 * type-friendly signatures for the TypeScript migration.
 */

function coerceDate(input) {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime()))
      return null;
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

function formatWithLocale(date, locale, formatter) {
  if (!date)
    return undefined;

  try {
    return locale ? formatter.call(date, locale) : formatter.call(date);
  } catch {
    return formatter.call(date);
  }
}

function formatShortDate(value, locale) {
  const date = coerceDate(value);
  if (!date)
    return undefined;
  return formatWithLocale(date, locale, Date.prototype.toLocaleDateString);
}

function formatLongDate(value, locale) {
  const date = coerceDate(value);
  if (!date)
    return undefined;
  return formatWithLocale(date, locale, Date.prototype.toLocaleString);
}

function formatISODate(value) {
  const date = coerceDate(value);
  return date ? date.toISOString() : undefined;
}

function isValidDateValue(value) {
  return coerceDate(value) !== null;
}

export {
  coerceDate,
  formatISODate,
  formatLongDate,
  formatShortDate,
  isValidDateValue
};
