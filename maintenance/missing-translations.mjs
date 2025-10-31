import path from 'node:path';
import { fileURLToPath } from 'node:url';

import jsonfile from 'jsonfile';

import languages from '../locales/languages.mjs';

/* eslint no-sync: "off" */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(moduleDir, '../locales');
const langKeys = languages.getValidLanguages();
// qqq is a pseudo language code (reserved for local use in the ISO standard)
// which, per translatewiki.net convention, is used for message documentation
langKeys.push('qqq');

const enMessageKeys = Object.keys(jsonfile.readFileSync(path.join(basePath, 'en.json')));

for (const langKey of langKeys) {
  if (langKey === 'en')
    continue;

  const messageKeys = Object.keys(jsonfile.readFileSync(path.join(basePath, `${langKey}.json`)));
  const missingKeys = enMessageKeys.filter(getKeyFilter(messageKeys));

  if (missingKeys.length) {
    console.log(`The following keys are missing from ${langKey}.json:`);
    console.log(missingKeys.join('\n'));
  }

  const extraKeys = messageKeys.filter(getKeyFilter(enMessageKeys));
  if (extraKeys.length) {
    console.log(`\nThe following keys exist in ${langKey}.json which are not in the English version:`);
    console.log(extraKeys.join('\n'));
  }
}

function getKeyFilter(xxMessageKeys) {
  return function(ele) {
    return xxMessageKeys.indexOf(ele) === -1;
  };
}
