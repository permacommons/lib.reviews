import type { Request } from 'express';

// Internal dependencies
import languages from '../../locales/languages.ts';

interface EmbeddedFeedOptions {
  atomURLPrefix?: string;
  atomURLTitleKey?: string;
}

interface EmbeddedFeed {
  url: string;
  type: 'application/atom+xml';
  title: string;
  language: string;
}

/**
 * Build <link> metadata for alternate Atom feeds so feed readers can discover
 * localized variants of the current page. Optionally prefixes feed URLs and
 * titles when provided.
 *
 * @param req
 *  Express request used for locale and translation helpers
 * @param options
 *  Configuration for URL prefix and i18n title key
 */
const getEmbeddedFeeds = (req: Request, options: EmbeddedFeedOptions = {}): EmbeddedFeed[] => {
  const { atomURLPrefix, atomURLTitleKey } = options;
  const embeddedFeeds: EmbeddedFeed[] = [];

  if (atomURLPrefix && atomURLTitleKey) {
    const currentLocale = (req.locale ?? 'en') as LibReviews.LocaleCode;
    embeddedFeeds.push({
      url: `${atomURLPrefix}/${currentLocale}`,
      type: 'application/atom+xml',
      title: `[${currentLocale}] ${req.__(atomURLTitleKey)}`,
      language: currentLocale,
    });

    const otherLanguages = languages.getValidLanguages().filter(lang => lang !== currentLocale);

    for (const otherLanguage of otherLanguages) {
      embeddedFeeds.push({
        url: `${atomURLPrefix}/${otherLanguage}`,
        type: 'application/atom+xml',
        title:
          `[${otherLanguage}] ` +
          req.__({
            phrase: atomURLTitleKey,
            locale: otherLanguage,
          }),
        language: otherLanguage,
      });
    }
  }

  return embeddedFeeds;
};

const feeds = {
  getEmbeddedFeeds,
};

export type FeedsHelper = typeof feeds;
export default feeds;
