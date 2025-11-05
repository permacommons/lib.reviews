import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import render from './helpers/render.ts';
import languages from '../locales/languages.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';

type PagesRouteRequest = HandlerRequest;
type PagesRouteResponse = HandlerResponse;
type LocaleCodeWithUndetermined = LibReviews.LocaleCodeWithUndetermined;

const router = Router();

const stat = promisify(fs.stat);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

router.get('/terms', function (req: PagesRouteRequest, res: PagesRouteResponse, next: HandlerNext) {
  resolveMultilingualTemplate('terms', req.locale)
    .then(templateName =>
      render.template(req, res, templateName, {
        deferPageHeader: true,
        titleKey: 'terms'
      })
    )
    .catch(next);
});

router.get('/faq', function (req: PagesRouteRequest, res: PagesRouteResponse, next: HandlerNext) {
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
async function resolveMultilingualTemplate(templateName: string, locale?: string): Promise<string> {
  let templateLanguages = languages.getFallbacks(locale ?? 'und');

  // Add the request language itself if not already a default fallback
  if (locale && !templateLanguages.includes(locale as LocaleCodeWithUndetermined))
    templateLanguages.unshift(locale as LocaleCodeWithUndetermined);

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
