import test from 'ava';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import languages from '../locales/languages.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import i18n from 'i18n';

i18n.configure({
  locales: languages.getValidLanguages(),
  directory: path.join(__dirname, '../locales'),
  defaultLocale: 'en',
  updateFiles: false,
  autoReload: false,
  syncFiles: false,
  objectNotation: true,
});

import md from '../util/md.ts';

test('Spoiler containers render localized summary', t => {
  const html = md.render('::: spoiler\nfoo\n:::\n', { language: 'en' });
  t.regex(html, /<details class="content-warning">/);
  t.regex(html, /Warning: The text below contains spoilers\./);
  t.regex(html, /<p>foo<\/p>/);
});

test('HTML5 media produces fallback description', t => {
  const html = md.render('![Caption](clip.ogg "Birdsong")\n', { language: 'en' });
  t.regex(html, /<audio src="clip\.ogg" title="Birdsong" controls class="html5-audio-player">/);
  t.regex(html, /download>download the file<\/a>/);
  t.regex(html, /Here is a description of the content: Caption/);
});
