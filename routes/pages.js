'use strict';

// External dependencies
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const stat = promisify(fs.stat);

// Internal dependencies
const render = require('./helpers/render');
const languages = require('../locales/languages');

router.get('/terms', function (req, res, next) {
  resolveMultilingualTemplate('terms', req.locale)
    .then(templateName =>
      render.template(req, res, templateName, {
        deferPageHeader: true,
        titleKey: 'terms'
      })
    )
    .catch(next);
});

router.get('/faq', function (req, res, next) {
  resolveMultilingualTemplate('faq', req.locale)
    .then(templateName =>
      render.template(req, res, templateName, {
        deferPageHeader: true,
        titleKey: 'faq'
      })
    )
    .catch(next);
});


// Detects the best available template in the multilingual templates directory
// for a given locale.
async function resolveMultilingualTemplate(templateName, locale) {
  let templateLanguages = languages.getFallbacks(locale);

  // Add the request language itself if not already a default fallback
  if (!templateLanguages.includes(locale))
    templateLanguages.unshift(locale);

  const getRelPath = language => `multilingual/${templateName}-${language}`,
    getAbsPath = relPath => path.join(__dirname, '../views', `${relPath}.hbs`);

  // Check existence of files, swallow errors
  const templateLookups = templateLanguages.map(language => {
    const relPath = getRelPath(language),
      absPath = getAbsPath(relPath);
    return stat(absPath).then(_r => relPath).catch(_e => null);
  });

  const templates = await Promise.all(templateLookups);
  for (let template of templates)
    if (template)
      return template;

  let langStr = templateLanguages.join(', ');
  throw new Error(`Template ${templateName} does not appear to exist in any of these languages: ${langStr}`);
}
module.exports = router;
