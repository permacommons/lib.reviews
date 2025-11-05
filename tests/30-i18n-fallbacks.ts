import test from 'ava';
import i18n from 'i18n';

const createCatalog = () => ({
  en: {
    'fallback message': 'Hello from default locale',
    'fallback plural': {
      one: '%s item in default locale',
      other: '%s items in default locale',
    },
  },
  fr: {},
});

const configureI18n = () =>
  i18n.configure({
    locales: ['en', 'fr'],
    defaultLocale: 'en',
    retryInDefaultLocale: true,
    autoReload: false,
    updateFiles: false,
    syncFiles: false,
    staticCatalog: createCatalog(),
  });

test.beforeEach(() => {
  configureI18n();
  i18n.setLocale('en');
});

test('falls back to default locale for missing translation', t => {
  i18n.setLocale('fr');

  t.is(i18n.__('fallback message'), 'Hello from default locale');
  t.is(
    i18n.__({
      phrase: 'fallback message',
      locale: 'fr',
    }),
    'Hello from default locale'
  );
});

test('plural forms fall back to default locale when missing', t => {
  i18n.setLocale('fr');

  t.is(i18n.__n('fallback plural', 1), '1 item in default locale');
  t.is(i18n.__n('fallback plural', 5), '5 items in default locale');
});
