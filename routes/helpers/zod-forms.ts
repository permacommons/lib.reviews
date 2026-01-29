import config from 'config';
import escapeHTML from 'escape-html';
import type { MultilingualString } from 'rev-dal/lib/ml-string';
import { z } from 'zod';
import languages from '../../locales/languages.ts';
import md from '../../util/md.ts';

type TranslateFn = (phrase: string, ...params: Array<string | number | boolean>) => string;

const sanitize = (value: string) => escapeHTML(value.trim());

/**
 * Normalize a form field value to an array. Single values become single-element arrays,
 * null/undefined become empty arrays, and arrays pass through unchanged.
 *
 * @param value Raw form field value
 * @returns Normalized array
 */
const preprocessArrayField = (value: unknown) =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

/**
 * Coerce a value to a string, treating null/undefined as empty strings.
 *
 * @param value Value to coerce
 * @returns String representation
 */
const coerceString = (value: unknown) =>
  value === undefined || value === null ? '' : String(value);

/**
 * Create a Zod schema for a required trimmed string field with custom error message.
 *
 * @param message Error message to show when field is empty
 * @returns Zod string schema
 */
const requiredTrimmedString = (message: string) =>
  z.preprocess(coerceString, z.string().trim().min(1, message));

const validateLanguage = (language: string, ctx: z.RefinementCtx) => {
  try {
    languages.validate(language);
    return true;
  } catch (_error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'invalid language code',
      path: [],
    });
    return false;
  }
};

/**
 * Create a Zod schema that transforms a string into a multilingual text object.
 * Validates the language code and escapes HTML in the value.
 *
 * @param language Language code for the text
 * @returns Zod schema producing a MultilingualString
 */
export const createMultilingualTextField = (language: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!validateLanguage(language, ctx)) return { [language]: '' } as Record<string, string>;
      return { [language]: sanitize(value) } as MultilingualString;
    });

/**
 * Create a Zod schema that transforms markdown text into a multilingual object
 * with both escaped text and rendered HTML.
 *
 * @param language Language code for the markdown
 * @param renderLocale Optional locale for rendering (defaults to language)
 * @returns Zod schema producing an object with text and html properties
 */
export const createMultilingualMarkdownField = (language: string, renderLocale?: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!validateLanguage(language, ctx))
        return {
          text: { [language]: '' } as MultilingualString,
          html: { [language]: '' } as MultilingualString,
        };

      const escaped = sanitize(value);
      const rendered = md.render(value.trim(), {
        language: renderLocale ?? language,
      });

      return {
        text: { [language]: escaped } as MultilingualString,
        html: { [language]: rendered } as MultilingualString,
      };
    });

export const csrfField = z.string().min(1, 'Missing CSRF token');
export const csrfSchema = z.object({ _csrf: csrfField });

const baseCaptchaFields = z.object({
  'captcha-id': z.string(),
  'captcha-answer': z.string().trim().min(1, 'CAPTCHA answer is required'),
});

/**
 * Check if CAPTCHA is enabled for a given form.
 *
 * @param formKey Form identifier to check CAPTCHA configuration
 * @returns true if CAPTCHA is enabled for this form
 */
export const isCaptchaEnabled = (formKey: string): boolean => {
  const formsConfig = config.questionCaptcha.forms as Record<string, string | boolean | undefined>;
  return Boolean(formsConfig[String(formKey)]);
};

/**
 * Create a Zod schema for CAPTCHA fields if enabled for the given form.
 * Returns an empty schema if CAPTCHA is not configured for this form.
 * Note: This only adds the fields - validation must be applied separately using validateCaptcha.
 *
 * @param formKey Form identifier to check CAPTCHA configuration
 * @returns Zod schema for CAPTCHA fields or empty schema
 */
export const createCaptchaSchema = (formKey: string) => {
  if (!isCaptchaEnabled(formKey)) return z.object({});
  return baseCaptchaFields;
};

/**
 * Create a superRefine callback that validates CAPTCHA answers.
 * Must be called AFTER merging the CAPTCHA schema into the form schema.
 *
 * @param formKey Form identifier to check CAPTCHA configuration
 * @param translate i18n function for error messages
 * @returns superRefine callback function, or undefined if CAPTCHA is disabled
 */
export const validateCaptcha = (formKey: string, translate: TranslateFn = phrase => phrase) => {
  if (!isCaptchaEnabled(formKey)) return undefined;

  const captchas = config.questionCaptcha.captchas as Array<{ answerKey: string }>;

  return (data: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const captchaId = data['captcha-id'];
    const captchaAnswer = data['captcha-answer'];

    if (typeof captchaId !== 'string' || typeof captchaAnswer !== 'string') {
      return;
    }

    // Skip validation if answer is empty - the basic field validation handles this
    if (captchaAnswer.trim().length === 0) {
      return;
    }

    const captchaIndex = Number.parseInt(captchaId, 10);
    const captcha = Number.isNaN(captchaIndex) ? undefined : captchas[captchaIndex];

    if (!captcha) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['captcha-id'],
        message: translate('unknown captcha'),
      });
      return;
    }

    const expected = translate(captcha.answerKey).toUpperCase();
    const provided = captchaAnswer.trim().toUpperCase();

    if (expected !== provided) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['captcha-answer'],
        message: translate('incorrect captcha answer'),
      });
    }
  };
};

const zodForms = {
  createMultilingualTextField,
  createMultilingualMarkdownField,
  csrfField,
  csrfSchema,
  createCaptchaSchema,
  validateCaptcha,
  isCaptchaEnabled,
  coerceString,
  preprocessArrayField,
  requiredTrimmedString,
};

export type ZodFormsHelper = typeof zodForms;
export default zodForms;
export { coerceString, preprocessArrayField, requiredTrimmedString };
