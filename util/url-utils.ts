import { parse as parseUrl, type UrlWithStringQuery } from 'node:url';

/** Normalization function referenced by the rule table below. */
type URLConverter = (inputURL: string) => string;

interface URLRule {
  host: RegExp;
  converter?: URLConverter | URLConverter[];
  tags?: string[];
  id?: string;
}

type URLPlacement = Record<string, string[]>;

type TaggedUrl = { id: string; url: string };

/** Options that influence how URLs are grouped by tag. */
export interface GetUrlsByTagOptions {
  onlyOneTag?: boolean;
  sortResults?: boolean;
}

/**
 * Escapes a string so it can be safely embedded as a literal within a `RegExp`
 * pattern.
 *
 * @param value - Raw string that may contain regex metacharacters.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Creates a hostname matcher that accepts an optional leading `www.` prefix.
 *
 * @param hostname - Hostname to match.
 */
function hostWithOptionalWww(hostname: string): RegExp {
  return new RegExp(`^(www\\.)?${escapeRegExp(hostname)}$`);
}

const urlRegex =
  /^(https?|ftp):\/\/(((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:)*@)?(((\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])\.(\d|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))|((([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|\d|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.)+(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])*([a-z]|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])))\.?)(:\d*)?)(\/((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)+(\/(([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)*)*)?)?(\?((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|[\uE000-\uF8FF]|\/|\?)*)?(#((([a-z]|\d|-|\.|_|~|[\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF])|(%[\da-f]{2})|[!$&'()*+,;=]|:|@)|\/|\?)*)*$/i;

const rules: URLRule[] = [
  {
    host: hostWithOptionalWww('amazon.com'),
    converter: _stripAmazonQueryStrings,
    tags: ['shops', 'reviews'],
    id: 'amazon',
  },
  {
    host: hostWithOptionalWww('wikidata.org'),
    tags: ['databases', 'opendata'],
    id: 'wikidata',
    converter: _stripFragment,
  },
  {
    host: hostWithOptionalWww('goodreads.com'),
    tags: ['reviews', 'databases'],
    id: 'goodreads',
  },
  {
    host: hostWithOptionalWww('openstreetmap.org'),
    tags: ['maps', 'opendata', 'databases'],
    id: 'openstreetmap',
  },
  {
    host: /^openlibrary\.org$/,
    tags: ['databases', 'opendata'],
    id: 'openlibrary',
    converter: _stripOpenLibraryTitleSuffix,
  },
  {
    host: hostWithOptionalWww('imdb.com'),
    tags: ['databases', 'reviews'],
    id: 'imdb',
  },
  {
    host: hostWithOptionalWww('omdb.org'),
    tags: ['databases', 'reviews'],
    id: 'omdb',
  },
  {
    host: hostWithOptionalWww('themoviedb.org'),
    tags: ['databases', 'reviews'],
    id: 'tmdb',
  },
  {
    host: hostWithOptionalWww('thetvdb.com'),
    tags: ['databases', 'reviews'],
    id: 'tvdb',
  },
  {
    host: hostWithOptionalWww('yelp.com'),
    tags: ['reviews', 'databases'],
    id: 'yelp',
  },
  {
    host: hostWithOptionalWww('tripadvisor.com'),
    tags: ['reviews', 'databases'],
    id: 'tripadvisor',
  },
  {
    host: hostWithOptionalWww('indiebound.org'),
    tags: ['shops'],
    id: 'indiebound',
  },
  {
    host: /^(.*\.)?wikipedia\.org$/,
    tags: ['summaries', 'databases', 'opendata'],
    id: 'wikipedia',
  },
  {
    host: /^store\.steampowered\.com$/,
    tags: ['shops', 'reviews'],
    id: 'steam',
  },
  {
    host: /^(.*\.)?itch\.io$/,
    tags: ['shops'],
    id: 'itch',
  },
  {
    host: hostWithOptionalWww('gog.com'),
    tags: ['shops'],
    id: 'gog',
  },
  {
    host: hostWithOptionalWww('librarything.com'),
    tags: ['reviews'],
    id: 'librarything',
  },
  {
    host: hostWithOptionalWww('f-droid.org'),
    tags: ['shops'],
    id: 'fdroid',
  },
  {
    host: hostWithOptionalWww('github.com'),
    tags: ['repositories'],
    id: 'github',
  },
  {
    host: hostWithOptionalWww('opencollective.com'),
    tags: ['crowdfunding'],
    id: 'opencollective',
  },
  {
    host: hostWithOptionalWww('liberapay.com'),
    tags: ['crowdfunding'],
    id: 'liberapay',
  },
];

const placement: URLPlacement = {
  crowdfunding: ['liberapay', 'opencollective']
  databases: ['wikidata', 'imdb', 'omdb', 'tmdb', 'tvdb'],
  maps: ['openstreetmap'],
  reviews: ['yelp', 'tripadvisor', 'goodreads', 'librarything'],
  repositories: ['github', 'codeberg'],
  shops: ['indiebound', 'itch', 'gog', 'steam', 'amazon', 'fdroid'],
  summaries: ['wikipedia'],
};

/** Legacy helper collection for URL normalization and presentation. */
const urlUtils = {
  /** Validates that the supplied string resembles an HTTP(S) or FTP URL. */
  validate(inputURL: string): boolean {
    return urlRegex.test(inputURL);
  },

  /**
   * Applies known normalization rules to the URL. Since the URL is parsed via
   * `url.parse`, special characters are also urlencoded.
   */
  normalize(inputURL: string): string {
    const parsedURL = parseUrl(inputURL) as UrlWithStringQuery | null;
    if (!parsedURL) return inputURL;

    let outputURL = parsedURL.href;

    const runAll = (converters: URLConverter[], url: string): string =>
      converters.reduce((acc, converter) => converter(acc), url);

    for (const rule of rules) {
      if (rule.converter && parsedURL.hostname && rule.host.test(parsedURL.hostname)) {
        if (Array.isArray(rule.converter)) outputURL = runAll(rule.converter, outputURL);
        else outputURL = rule.converter(outputURL);
      }
    }

    return outputURL;
  },

  /** Groups incoming URLs by the associated rule tags. */
  getURLsByTag(
    inputURLs: string[] = [],
    options: GetUrlsByTagOptions = {}
  ): Record<string, TaggedUrl[]> {
    const { onlyOneTag = false, sortResults = false } = options;
    const rv: Record<string, TaggedUrl[]> = {};
    for (const inputURL of inputURLs) {
      let recognized = false;
      const parsedURL = parseUrl(inputURL) as UrlWithStringQuery | null;
      if (!parsedURL || !parsedURL.hostname) continue;
      for (const rule of rules) {
        if (rule.host.test(parsedURL.hostname) && rule.tags && rule.id) {
          for (const tag of rule.tags) {
            if (rv[tag] === undefined) rv[tag] = [];
            rv[tag].push({ id: rule.id, url: inputURL });
            recognized = true;
            if (onlyOneTag) break;
          }
        }
      }

      if (!recognized) {
        if (rv.other === undefined) rv.other = [];
        rv.other.push({ id: 'unknown', url: inputURL });
      }
    }

    if (sortResults) {
      for (const [tag, urls] of Object.entries(rv)) {
        const ordering = placement[tag];
        if (!Array.isArray(ordering)) continue;
        urls.sort((obj1, obj2) => comparePlacement(ordering, obj1.id, obj2.id));
      }
    }

    return rv;
  },

  /**
   * Produces a compact representation of the URL, removing protocol and
   * trailing slash noise for display purposes.
   */
  prettify(inputURL: string): string {
    return inputURL
      .replace(/^.*?:\/\//, '') // strip protocol
      .replace(/\/$/, ''); // remove trailing slashes
  },
};

/** Sort helper that mirrors the legacy URL placement ordering. */
function comparePlacement(order: string[], id1: string, id2: string): number {
  const index1 = order.indexOf(id1);
  const index2 = order.indexOf(id2);

  const inOrder1 = index1 !== -1;
  const inOrder2 = index2 !== -1;

  if (index1 > index2) return inOrder2 ? 1 : -1;
  if (index1 < index2) return inOrder1 ? -1 : 1;
  return 0;
}

/** Collapses OpenLibrary URLs to a canonical work/book slug. */
function _stripOpenLibraryTitleSuffix(inputURL: string): string {
  const match = inputURL.match(/^https*:\/\/openlibrary.org\/(works|books)\/(OL[^\/]+)\/*(.*)$/i);
  if (match === null) return inputURL;
  else return `https://openlibrary.org/${match[1]}/${match[2]}`;
}

/** Removes affiliate and tracking query parameters from Amazon URLs. */
function _stripAmazonQueryStrings(inputURL: string): string {
  const regex = /(.*\/)ref=.*$/;
  const match = inputURL.match(regex);
  if (Array.isArray(match) && match[1]) return match[1];
  else return inputURL;
}

/** Drops URL fragments that do not influence canonical resource identity. */
function _stripFragment(inputURL: string): string {
  return inputURL.split('#')[0];
}

export default urlUtils;
