import type { Request } from 'express';

// Internal dependencies
import languages from '../../locales/languages.js';

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
    embeddedFeeds.push({
      url: `${atomURLPrefix}/${req.locale}`,
      type: 'application/atom+xml',
      title: `[${req.locale}] ${req.__(atomURLTitleKey)}`,
      language: req.locale ?? 'en'
    });

    const otherLanguages = languages.getValidLanguages();
    const currentIndex = otherLanguages.indexOf(req.locale ?? '');
    if (currentIndex !== -1)
      otherLanguages.splice(currentIndex, 1);

    for (const otherLanguage of otherLanguages) {
      embeddedFeeds.push({
        url: `${atomURLPrefix}/${otherLanguage}`,
        type: 'application/atom+xml',
        title: `[${otherLanguage}] ` + req.__({
          phrase: atomURLTitleKey,
          locale: otherLanguage
        }),
        language: otherLanguage
      });
    }
  }

  return embeddedFeeds;
};

const feeds = {
  getEmbeddedFeeds
};

export type FeedsHelper = typeof feeds;
export default feeds;
