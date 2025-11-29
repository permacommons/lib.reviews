import type { Request } from 'express';
import { type ZodIssue, z } from 'zod';
import languages from '../../locales/languages.ts';

type MessageFormatter = (issue: ZodIssue) => string;

/**
 * Shared Zod helpers for form handling:
 * - validateLanguage: validate/flash language errors
 * - formatZodIssueMessage: map Zod issues to localized strings
 * - safeParseField: reuse field parsers for fallback/preview values
 * - flashZodIssues: emit issues to flash buckets
 */

/**
 * Flash all Zod issues using a formatter.
 *
 * @param req Express request (provides flash)
 * @param issues Zod issues to render
 * @param formatter Maps an issue to a display string (defaults to issue.message)
 * @param bucket Flash bucket name (defaults to "pageErrors")
 */
const flashZodIssues = (
  req: Request,
  issues: ZodIssue[],
  formatter: MessageFormatter = issue => issue.message,
  bucket = 'pageErrors'
) => {
  issues.forEach(issue => req.flash(bucket, formatter(issue)));
};

const validateLanguage = (req: Request, language?: string) => {
  const trimmed = language?.trim();

  if (!trimmed) {
    req.flash('pageErrors', req.__('need language'));
    return;
  }

  try {
    languages.validate(trimmed);
  } catch (error) {
    req.flashError?.(error);
  }
};

const formatZodIssueMessage = (
  req: Request,
  issue: ZodIssue,
  unexpectedKey = 'unexpected form data'
) => (issue.code === 'unrecognized_keys' ? req.__(unexpectedKey) : issue.message);

const safeParseField = <T>(schema: z.ZodTypeAny, value: unknown): T | undefined => {
  const result = schema.safeParse(value);
  return result.success ? (result.data as T) : undefined;
};

export type { MessageFormatter };
export { flashZodIssues, formatZodIssueMessage, safeParseField, validateLanguage };
