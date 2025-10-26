import test from 'ava';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

process.env.NODE_ENV = 'development';
process.env.NODE_CONFIG_DISABLE_WATCH = 'Y';
process.env.NODE_APP_INSTANCE = 'testing-markdown';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.NODE_CONFIG_DIR = path.join(__dirname, '../config');

const require = createRequire(import.meta.url);
const i18n = require('i18n');
const languages = require('../locales/languages');

i18n.configure({
  locales: languages.getValidLanguages(),
  directory: path.join(__dirname, '../locales'),
  defaultLocale: 'en',
  updateFiles: false,
  autoReload: false,
  syncFiles: false,
  objectNotation: true
});

const md = require('../util/md');

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
