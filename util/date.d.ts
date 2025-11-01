export type DateInput = Date | string | number | null | undefined;

export function coerceDate(input: DateInput): Date | null;
export function formatShortDate(input: DateInput, locale?: string): string | undefined;
export function formatLongDate(input: DateInput, locale?: string): string | undefined;
export function formatISODate(input: DateInput): string | undefined;
export function isValidDateValue(input: DateInput): boolean;
