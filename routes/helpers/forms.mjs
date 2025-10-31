import config from 'config';
import escapeHTML from 'escape-html';
import md from '../../util/md.mjs';
import urlUtils from '../../util/url-utils.mjs';
import languages from '../../locales/languages.js';

// Used for field names in forms that support UUID wildcards
const uuidRegex = '([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89aAbB][a-f0-9]{3}-[a-f0-9]{12})';

// Used for the UUID type
const uuidRegexStrict = new RegExp(`^${uuidRegex}$`);

const forms = {
  // TODO: refactor me
  /* eslint complexity: "off" */
  parseSubmission(req, options) {
    options = Object.assign({
      // A form schema that tells us what to do with specific fields
      formDef: undefined,
      // A globally unique key for this form that we can use to trigger
      // certain configured actions, like adding a CAPTCHA to some forms
      formKey: undefined,
      // The language of content that is being processed. Currently we expect
      // that a submission has exactly one language (i.e. not multiple
      // languages being edited at the sam etime)
      language: undefined,
      // An array of field names that scan be skipped entirely. This is useful
      // when a required field has been provided from a source outside the form.
      skipRequiredCheck: []
    }, options);

    forms.checkLanguage(req, options.language);

    // Do not manipulate original form definition
    let formDef = Object.assign([], options.formDef);
    let formKey = options.formKey;

    let hasRequiredFields = true;
    let hasUnknownFields = false;
    let hasCorrectCaptcha = null;
    let formValues = {};
    let processedKeys = Object.keys(req.body);

    // Any form submission requires a CSRF token
    formDef.push({
      name: '_csrf',
      required: true,
      skipValue: true
    });

    // Process simple captcha if enabled for this form
    if (config.questionCaptcha.forms[formKey]) {
      formDef.push({
        name: 'captcha-id',
        required: true
      }, {
        name: 'captcha-answer',
        required: true
      });

      hasCorrectCaptcha = forms.processCaptchaAnswer(req);
    }

    // We support UUID wildcards in form names, so we have to unpack those
    // based on the contents of the actual body. This function will change the
    // contents of formDef and derive a new field for each body key that
    // matches the wildcard. It will then remove the original wildcard
    // field before we process the form.
    formDef = forms.unpackWildcards(formDef, req.body);

    for (let field of formDef) {

      // We keep track of body keys we've processed so we can flag
      // unknown data later
      let k = processedKeys.indexOf(field.name);
      if (k !== -1)
        processedKeys.splice(k, 1);

      // We can map form keys to object keys if desired, using the 'key'
      // option in the form definition.
      let key = field.keyValueMap || field.key || field.name;

      // We can exempt fields from the check, e.g., because we already have
      // the data for that field from another source than the form
      if (!options.skipRequiredCheck || options.skipRequiredCheck.indexOf(field.name) == -1) {

        if (!req.body[field.name] && field.required) {
          req.flash('pageErrors', req.__(`need ${field.name}`));
          hasRequiredFields = false;
          continue;
        }
      }

      // No further processing on fields that have the "skipValue" option, or that
      // bypass checks for other reasons. These won't be in the formValues object.
      if (field.skipValue || options.skipRequiredCheck.indexOf(field.name) != -1)
        continue;

      let val;

      // Coerce type if we have a value
      if (req.body[field.name] !== undefined) {
        switch (field.type) {

          case 'number':
            val = Number(req.body[field.name].trim());
            break;

          case 'uuid':
            if (!uuidRegexStrict.test(req.body[field.name].trim())) {
              val = null;
            } else {
              val = req.body[field.name].trim();
            }
            break;

          case 'url':
            // This also encodes any special characters
            val = urlUtils.normalize(req.body[field.name].trim());
            break;

            // Multilingual text that needs to be trimmed and escaped
          case 'text':
            val = {
              [options.language]: escapeHTML(req.body[field.name].trim())
            };
            break;

            // Multilingual markdown, we preserve both the escaped text and the
            // rendered markdown
          case 'markdown':
            if (!field.flat)
              val = {
                text: {
                  [options.language]: escapeHTML(req.body[field.name].trim())
                },
                html: {
                  [options.language]: md.render(req.body[field.name].trim(), { language: req.locale })
                }
              };

            // For schemas with a single text field, we support a flat structure
            else {
              formValues[key] = {
                [options.language]: escapeHTML(req.body[field.name].trim())
              };

              formValues[field.htmlKey] = {
                [options.language]: md.render(req.body[field.name].trim(), { language: req.locale })
              };
            }
            break;

          case 'boolean':
            val = Boolean(req.body[field.name]);
            break;

          default:
            val = req.body[field.name];

        }
      }

      // Assign value. We push it into an array for wildcard fields.
      if (val !== undefined) {
        if (field.keyValueMap) {

          // Get and use a UUID if there is one
          let id = (field.name.match(uuidRegex) || [])[1];

          if (typeof formValues[key] !== 'object')
            formValues[key] = [];

          if (id)
            formValues[key][id] = val;
          else
            formValues[key].push(val);
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
      formValues
    };
  },

  // We continue processing the whole form if the language is invalid, but
  // add an error to the flash
  checkLanguage(req, language) {
    if (language) {
      try {
        languages.validate(language);
      } catch (error) {
        req.flashError(error);
      }
    }
  },

  getQuestionCaptcha(formKey) {
    let id;
    if (config.questionCaptcha.forms[formKey]) {
      id = Math.floor(Math.random() * config.questionCaptcha.captchas.length);
      return {
        id,
        captcha: config.questionCaptcha.captchas[id]
      };
    } else
      return undefined;
  },

  processCaptchaAnswer(req) {

    let id = req.body['captcha-id'];
    let answerText = req.body['captcha-answer'];

    if (!answerText) //  no need to flash - missing field error message will kick in
      return false;

    if (!config.questionCaptcha.captchas[id]) {
      req.flash('pageErrors', req.__('unknown captcha'));
      return false;
    }

    if (answerText.trim().toUpperCase() !== req.__(config.questionCaptcha.captchas[id].answerKey).toUpperCase()) {
      req.flash('pageErrors', req.__('incorrect captcha answer'));
      return false;
    } else
      return true;
  },

  unpackWildcards(formDef, body) {

    for (let field of formDef) {

      // Is this a field with a wildcard?
      if (/%uuid/.test(field.name)) {

        // search the body for any occurrences of the UUID pattern
        let regex = new RegExp('^' + field.name.replace('%uuid', uuidRegex) + '$');

        for (let bodyKey in body) {
          if (bodyKey.match(regex)) {
            // Create a new field for each body key that matches
            let fd = Object.assign({}, field);
            fd.name = bodyKey;
            formDef.push(fd);
          }
        }
      }
    }
    // Remove the wildcard defs
    formDef = formDef.filter(field => !/%uuid/.test(field.name));
    return formDef;

  }

};

export default forms;
