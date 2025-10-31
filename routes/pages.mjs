import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import render from './helpers/render.mjs';
import languages from '../locales/languages.mjs';

const router = express.Router();

const stat = promisify(fs.stat);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
export default router;
