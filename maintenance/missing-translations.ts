import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import jsonfile from 'jsonfile';

import languages from '../locales/languages.ts';

type MessageCatalog = Record<string, string>;
type SupportedLocale = LibReviews.LocaleCode | 'qqq';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(moduleDir, '../locales');

const options = {
  lang: {
    type: 'string',
    multiple: true,
  },
  'fail-on-missing': {
    type: 'boolean',
  },
  'fail-on-extra': {
    type: 'boolean',
  },
  help: {
    type: 'boolean',
  },
} as const;

const { values } = parseArgs({
  options,
  args: process.argv.slice(2),
});

if (values.help) {
  console.log(`
Usage: maintenance/missing-translations.ts [options]

Options:
  --lang <lang>        Language code(s) to check. Can be specified multiple times.
                       (default: all available languages + qqq)
  --fail-on-missing    Exit with error code 1 if missing keys are found.
  --fail-on-extra      Exit with error code 1 if extra keys are found.
  --help               Show this help message.
`);
  process.exit(0);
}

const allLangKeys: SupportedLocale[] = [...languages.getValidLanguages(), 'qqq'];

let langKeys: SupportedLocale[];
if (values.lang && values.lang.length > 0) {
  langKeys = values.lang.filter((l): l is SupportedLocale =>
    allLangKeys.includes(l as SupportedLocale)
  );
  if (langKeys.length !== values.lang.length) {
    console.warn('Warning: Some specified languages were invalid and ignored.');
  }
} else {
  langKeys = allLangKeys;
}

const enMessageKeys = Object.keys(
  jsonfile.readFileSync<MessageCatalog>(path.join(basePath, 'en.json'))
);

let hasError = false;

for (const langKey of langKeys) {
  if (langKey === 'en') continue;

  const messageKeys = Object.keys(
    jsonfile.readFileSync<MessageCatalog>(path.join(basePath, `${langKey}.json`))
  );
  const missingKeys = enMessageKeys.filter(getKeyFilter(messageKeys));

  if (missingKeys.length) {
    console.log(`The following keys are missing from ${langKey}.json:`);
    console.log(missingKeys.join('\n'));
    if (values['fail-on-missing']) hasError = true;
  }

  const extraKeys = messageKeys.filter(getKeyFilter(enMessageKeys));
  if (extraKeys.length) {
    console.log(
      `\nThe following keys exist in ${langKey}.json which are not in the English version:`
    );
    console.log(extraKeys.join('\n'));
    if (values['fail-on-extra']) hasError = true;
  }
}

function getKeyFilter(referenceKeys: string[]) {
  return (candidateKey: string): boolean => !referenceKeys.includes(candidateKey);
}

if (hasError) {
  process.exit(1);
}
