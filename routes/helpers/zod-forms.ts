import config from 'config';
import escapeHTML from 'escape-html';
import { z } from 'zod';
import type { MultilingualString } from '../../dal/lib/ml-string.ts';
import languages from '../../locales/languages.ts';
import md from '../../util/md.ts';

type TranslateFn = (phrase: string, ...params: Array<string | number | boolean>) => string;

const sanitize = (value: string) => escapeHTML(value.trim());
const preprocessArrayField = (value: unknown) =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const coerceString = (value: unknown) =>
  value === undefined || value === null ? '' : String(value);
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

export const createMultilingualTextField = (language: string) =>
  z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (!validateLanguage(language, ctx)) return { [language]: '' } as Record<string, string>;
      return { [language]: sanitize(value) } as MultilingualString;
    });

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

export const createCaptchaSchema = (formKey: string, translate: TranslateFn = phrase => phrase) => {
  const formsConfig = config.questionCaptcha.forms as Record<string, string | boolean | undefined>;
  const isEnabled = formsConfig[String(formKey)];
  if (!isEnabled) return z.object({});

  const captchas = config.questionCaptcha.captchas as Array<{ answerKey: string }>;

  return baseCaptchaFields.superRefine((data, ctx) => {
    const captchaIndex = Number.parseInt(data['captcha-id'], 10);
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
    const provided = data['captcha-answer'].trim().toUpperCase();

    if (expected !== provided) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['captcha-answer'],
        message: translate('incorrect captcha answer'),
      });
    }
  });
};

const zodForms = {
  createMultilingualTextField,
  createMultilingualMarkdownField,
  csrfField,
  csrfSchema,
  createCaptchaSchema,
  coerceString,
  preprocessArrayField,
  requiredTrimmedString,
};

export type ZodFormsHelper = typeof zodForms;
export default zodForms;
export { coerceString, preprocessArrayField, requiredTrimmedString };
