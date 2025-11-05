import config from 'config';
import escapeHTML from 'escape-html';
import type { Request } from 'express';
import languages from '../../locales/languages.ts';
import md from '../../util/md.ts';
import urlUtils from '../../util/url-utils.ts';

// Used for field names in forms that support UUID wildcards
const uuidRegex = '([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89aAbB][a-f0-9]{3}-[a-f0-9]{12})';

// Used for the UUID type
const uuidRegexStrict = new RegExp(`^${uuidRegex}$`);

type FormField = {
  name: string;
  required?: boolean;
  skipValue?: boolean;
  key?: string;
  keyValueMap?: string;
  htmlKey?: string;
  type?: string;
  flat?: boolean;
  [key: string]: unknown;
};

/**
 * Options that control how form submissions are parsed.
 *
 * @property formDef
 *  Schema that defines how to interpret individual form fields
 * @property formKey
 *  Globally unique key used to enable configured behaviour like CAPTCHAs
 * @property language
 *  Language code for localized inputs within the submission
 * @property skipRequiredCheck
 *  Fields that should skip required validation, typically provided externally
 */
interface ParseSubmissionOptions {
  formDef?: FormField[];
  formKey?: string;
  language?: string;
  skipRequiredCheck?: string[];
}

interface ParseSubmissionResult {
  hasRequiredFields: boolean;
  hasUnknownFields: boolean;
  hasCorrectCaptcha: boolean | null;
  formValues: Record<string, any>;
}

const toStringValue = (value: unknown): string => String(value ?? '');

const forms = {
  // TODO: refactor me
  /**
   * Parse and validate a form submission according to a schema definition.
   * Applies CSRF, CAPTCHA, and field type conversions before returning
   * structured values.
   *
   * @param req
   *  Incoming request with form data in the body
   * @param options
   *  Form definition and behaviour overrides for this submission
   * @returns Parsed values and validation status flags
   */
  parseSubmission(req: Request, options: ParseSubmissionOptions = {}): ParseSubmissionResult {
    const resolvedOptions = Object.assign(
      {
        formDef: undefined as FormField[] | undefined,
        formKey: undefined as string | undefined,
        language: undefined as string | undefined,
        skipRequiredCheck: [] as string[],
      },
      options
    );

    forms.checkLanguage(req, resolvedOptions.language);

    // Do not manipulate original form definition
    let formDef = Object.assign([], resolvedOptions.formDef ?? []);
    const formKey = resolvedOptions.formKey;

    let hasRequiredFields = true;
    let hasUnknownFields = false;
    let hasCorrectCaptcha: boolean | null = null;
    const formValues: Record<string, any> = {};
    const processedKeys = Object.keys((req.body ?? {}) as Record<string, unknown>);

    // Any form submission requires a CSRF token
    formDef.push({
      name: '_csrf',
      required: true,
      skipValue: true,
    });

    // Process simple captcha if enabled for this form
    const captchaFormKey = String(formKey);
    const formsConfig = config.questionCaptcha.forms as unknown as Record<
      string,
      string | undefined
    >;
    const configuredCaptcha = formsConfig[captchaFormKey];

    if (configuredCaptcha) {
      formDef.push(
        {
          name: 'captcha-id',
          required: true,
        },
        {
          name: 'captcha-answer',
          required: true,
        }
      );

      hasCorrectCaptcha = forms.processCaptchaAnswer(req);
    }

    formDef = forms.unpackWildcards(formDef, (req.body ?? {}) as Record<string, unknown>);

    for (const field of formDef) {
      const processedIndex = processedKeys.indexOf(field.name);
      if (processedIndex !== -1) processedKeys.splice(processedIndex, 1);

      const key = (field.keyValueMap as string) || (field.key as string) || field.name;

      if (resolvedOptions.skipRequiredCheck.indexOf(field.name) === -1) {
        if (!req.body?.[field.name] && field.required) {
          req.flash('pageErrors', req.__(`need ${field.name}`));
          hasRequiredFields = false;
          continue;
        }
      }

      if (field.skipValue || resolvedOptions.skipRequiredCheck.indexOf(field.name) !== -1) continue;

      let val: unknown;

      if (req.body?.[field.name] !== undefined) {
        switch (field.type) {
          case 'number':
            val = Number(toStringValue(req.body[field.name]).trim());
            break;

          case 'uuid':
            {
              const trimmed = toStringValue(req.body[field.name]).trim();
              val = uuidRegexStrict.test(trimmed) ? trimmed : null;
            }
            break;

          case 'url':
            val = urlUtils.normalize(toStringValue(req.body[field.name]).trim());
            break;

          case 'text':
            val = {
              [resolvedOptions.language as string]: escapeHTML(
                toStringValue(req.body[field.name]).trim()
              ),
            };
            break;

          case 'markdown':
            if (!field.flat) {
              val = {
                text: {
                  [resolvedOptions.language as string]: escapeHTML(
                    toStringValue(req.body[field.name]).trim()
                  ),
                },
                html: {
                  [resolvedOptions.language as string]: md.render(
                    toStringValue(req.body[field.name]).trim(),
                    {
                      language: req.locale,
                    }
                  ),
                },
              };
            } else {
              formValues[key] = {
                [resolvedOptions.language as string]: escapeHTML(
                  toStringValue(req.body[field.name]).trim()
                ),
              };
              formValues[field.htmlKey as string] = {
                [resolvedOptions.language as string]: md.render(
                  toStringValue(req.body[field.name]).trim(),
                  {
                    language: req.locale,
                  }
                ),
              };
            }
            break;

          case 'boolean':
            val = Boolean(req.body[field.name]);
            break;

          default:
            val = req.body?.[field.name];
        }
      }

      if (val !== undefined) {
        if (field.keyValueMap) {
          const id = (field.name.match(uuidRegex) || [])[1];

          // FIXME: This creates an array [] and then adds properties to it like arr['uuid'] = val,
          // resulting in an array with length 0 but with properties. This is semantically confusing
          // and requires downstream code to call Object.keys() to extract the property names.
          // Should initialize as {} for UUID-based key-value maps and [] only for true arrays.
          if (typeof formValues[key] !== 'object') formValues[key] = [];

          if (id) formValues[key][id] = val;
          else formValues[key].push(val);
        } else {
          formValues[key] = val;
        }
      }
    }

    if (processedKeys.length) {
      hasUnknownFields = true;
      req.flash('pageErrors', req.__('unexpected form data'));
    }

    return {
      hasRequiredFields,
      hasUnknownFields,
      hasCorrectCaptcha,
      formValues,
    };
  },

  // We continue processing the whole form if the language is invalid, but
  // add an error to the flash
  checkLanguage(req: Request, language?: string) {
    if (language) {
      try {
        languages.validate(language);
      } catch (error) {
        req.flashError?.(error);
      }
    }
  },

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

  unpackWildcards(formDef: FormField[], body: Record<string, unknown>) {
    for (const field of formDef) {
      if (/%uuid/.test(field.name)) {
        const regex = new RegExp('^' + field.name.replace('%uuid', uuidRegex) + '$');

        for (const bodyKey in body) {
          if (regex.test(bodyKey)) {
            const fd = Object.assign({}, field);
            fd.name = bodyKey;
            formDef.push(fd);
          }
        }
      }
    }

    return formDef.filter(field => !/%uuid/.test(field.name));
  },
};

export type FormsHelper = typeof forms;
export default forms;
