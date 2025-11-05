import path from 'node:path';
import { fileURLToPath } from 'node:url';

import jsonfile from 'jsonfile';

import languages from '../locales/languages.ts';

/* eslint no-sync: "off" */

type MessageCatalog = Record<string, string>;
type SupportedLocale = LibReviews.LocaleCode | 'qqq';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(moduleDir, '../locales');
const langKeys: SupportedLocale[] = [...languages.getValidLanguages()];
// qqq is a pseudo language code (reserved for local use in the ISO standard)
// which, per translatewiki.net convention, is used for message documentation
langKeys.push('qqq');

const enMessageKeys = Object.keys(
  jsonfile.readFileSync<MessageCatalog>(path.join(basePath, 'en.json'))
);

for (const langKey of langKeys) {
  if (langKey === 'en') continue;

  const messageKeys = Object.keys(
    jsonfile.readFileSync<MessageCatalog>(path.join(basePath, `${langKey}.json`))
  );
  const missingKeys = enMessageKeys.filter(getKeyFilter(messageKeys));

  if (missingKeys.length) {
    console.log(`The following keys are missing from ${langKey}.json:`);
    console.log(missingKeys.join('\n'));
  }

  const extraKeys = messageKeys.filter(getKeyFilter(enMessageKeys));
  if (extraKeys.length) {
    console.log(
      `\nThe following keys exist in ${langKey}.json which are not in the English version:`
    );
    console.log(extraKeys.join('\n'));
  }
}

function getKeyFilter(referenceKeys: string[]) {
  return (candidateKey: string): boolean => !referenceKeys.includes(candidateKey);
}
