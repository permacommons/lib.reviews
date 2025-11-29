import config from 'config';
import type { Request } from 'express';

const toStringValue = (value: unknown): string => String(value ?? '');

const forms = {

  /**
   * Retrieve the configured captcha metadata for a form, if present.
   *
   * @param req
   *  Request used to localize the captcha text
   * @param formKey
   *  Identifier for the form to look up configuration
   */
  getCaptcha(req: Request, formKey?: string) {
    const captchaFormKey = String(formKey);
    const formsConfig = config.questionCaptcha.forms as unknown as Record<
      string,
      string | undefined
    >;
    const id = formsConfig[captchaFormKey];

    if (id) {
      return {
        id,
        question: req.__(config.questionCaptcha.captchas[id].questionKey),
        placeholder: req.__(config.questionCaptcha.captchas[id].placeholderKey),
        captcha: config.questionCaptcha.captchas[id],
      };
    }
    return undefined;
  },

  /**
   * Provide a random question captcha when the legacy flow is enabled.
   *
   * @param formKey
   *  Identifier for the form requesting captcha data
   */
  getQuestionCaptcha(formKey?: string) {
    const formsConfig = config.questionCaptcha.forms as unknown as Record<
      string,
      boolean | undefined
    >;
    if (!formKey || !formsConfig[String(formKey)]) return undefined;

    const captchas = config.questionCaptcha.captchas as Array<Record<string, unknown>>;
    const id = Math.floor(Math.random() * captchas.length);
    return {
      id,
      captcha: captchas[id],
    };
  },

  /**
   * Validate the answer for a simple question captcha.
   *
   * Missing answers rely on required field validation and therefore do not
   * emit additional flash messages here.
   */
  processCaptchaAnswer(req: Request) {
    const id = req.body?.['captcha-id'];
    const answerText = req.body?.['captcha-answer'];

    if (!answerText) return false;

    if (!config.questionCaptcha.captchas[id]) {
      req.flash('pageErrors', req.__('unknown captcha'));
      return false;
    }

    const expected = req.__(config.questionCaptcha.captchas[id].answerKey).toUpperCase();
    if (toStringValue(answerText).trim().toUpperCase() !== expected) {
      req.flash('pageErrors', req.__('incorrect captcha answer'));
      return false;
    }
    return true;
  },
};

export type FormsHelper = typeof forms;
export default forms;
