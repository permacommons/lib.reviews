/**
 * Open Library backend adapter (TypeScript).
 * Performs book/work metadata lookups including title, subtitle and authorship.
 */

/* External deps */
import config from 'config';
import { decodeHTML } from 'entities';
import escapeHTML from 'escape-html';
import stripTags from 'striptags';
import debug from '../util/debug.ts';
import { fetchJSON } from '../util/http.ts';

/* Internal deps */
import AbstractBackendAdapter, {
  type AdapterLookupResult,
  type AdapterMultilingualString,
} from './abstract-backend-adapter.ts';

/**
 * OL uses ISO639-3 codes; map to lib.reviews native codes.
 */
const openLibraryToNative: Record<string, string> = {
  eng: 'en',
  ben: 'bn',
  ger: 'de',
  esp: 'eo',
  spa: 'es',
  fre: 'fr',
  hun: 'hu',
  ita: 'it',
  jpn: 'ja',
  mac: 'mk',
  dut: 'nl',
  por: 'pt', // OL code does not disambiguate; assume Brazilian Portuguese
  swe: 'sv',
  chi: 'zh', // OL code does not disambiguate; assume Simplified Chinese
};

/**
 * Author reference shape used in OL work/edition payloads.
 * Sometimes nested under author.key, sometimes directly under key.
 */
interface OpenLibraryAuthorRef {
  author?: { key: string };
  key?: string;
}

/** Minimal subset of OL work/edition JSON we rely on. */
interface OpenLibraryWorkOrEdition {
  title?: string;
  subtitle?: string;
  authors?: OpenLibraryAuthorRef[];
  languages?: Array<{ key: string }>;
}

/** Minimal subset of OL author JSON we rely on. */
interface OpenLibraryAuthor {
  name?: string;
  personal_name?: string;
}

export default class OpenLibraryBackendAdapter extends AbstractBackendAdapter {
  constructor() {
    super();

    // Let's break it down:
    // - HTTP or HTTPS
    // - works or books (not authors or other stuff on the site)
    // - OL<anything except "." or "/">
    // - maybe followed by a slash, and maybe some more stuff after that
    // - which we don't care about hence the non-capturing groups (?:)
    // - case doesn't matter
    this.supportedPattern =
      /^https*:\/\/openlibrary.org\/(works|books)\/(OL[^\/.]+)(?:\/(?:.*))*$/i;
    this.supportedFields = ['label', 'authors', 'subtitle'];
    this.sourceID = 'openlibrary';
    this.sourceURL = 'https://openlibrary.org/';
    this.throttleMs = 2000; // Wait 2 seconds between OpenLibrary requests
  }

  protected async _lookup(url: string): Promise<AdapterLookupResult> {
    const m = url.match(this.supportedPattern);
    if (m === null)
      throw new Error('URL does not appear to reference an Open Library work or edition.');

    // Open Library distinguishes works and editions. Editions contain
    // significantly more metadata and are generally preferred. We cannot
    // guess the edition, however -- even if only one exists in Open Library,
    // others may exist in the world.
    const isEdition = m[1] === 'books';

    // The string at the end of the original URL must be stripped off for
    // obtaining the JSON representation.
    const jsonURL = isEdition
      ? `https://openlibrary.org/books/${m[2]}.json`
      : `https://openlibrary.org/works/${m[2]}.json`;

    const data = await fetchJSON<OpenLibraryWorkOrEdition>(jsonURL, {
      timeout: config.adapterTimeout,
      label: 'Open Library',
      headers: {
        'User-Agent': config.adapterUserAgent,
      },
    });
    debug.adapters(
      'Received data from Open Library adapter (book/edition lookup):\\n' +
        JSON.stringify(data, null, 2)
    );

    if (typeof data !== 'object' || !data.title)
      throw new Error('Result from Open Library did not include a work or edition title.');

    let language = 'und'; // undetermined language, which is a valid key for storage

    if (Array.isArray(data.languages) && data.languages.length) {
      const languageKey = data.languages[0].key;
      const code = (languageKey.match(/\/languages\/(.*)/) || [])[1];
      language = openLibraryToNative[code] || language;
    }

    const result: AdapterLookupResult = {
      data: {
        // Sanitize: strip tags, decode, then escape to get HTML-safe text
        label: { [language]: escapeHTML(stripTags(decodeHTML(data.title))) },
      },
      sourceID: this.sourceID,
    };

    if (data.subtitle) {
      result.data.subtitle = {
        // Sanitize: strip tags, decode, then escape to get HTML-safe text
        [language]: escapeHTML(stripTags(decodeHTML(data.subtitle))),
      };
    }

    try {
      const authors = await this.getAuthors(data.authors);
      Object.assign(result.data, authors);
    } catch (error) {
      // Preserve legacy behavior: swallow author lookup errors and return partial data
      debug.error({ error });
      return result;
    }

    return result;
  }

  /**
   * Retrieve a set of authors from keys specified in a work or edition.
   * Requires the object array from the work or edition record.
   * Does not catch lookup failures.
   */
  async getAuthors(
    authorObjArr: OpenLibraryAuthorRef[] | undefined
  ): Promise<{ authors?: Array<AdapterMultilingualString> }> {
    const result: { authors?: Array<AdapterMultilingualString> } = {};

    if (!Array.isArray(authorObjArr) || !authorObjArr.length) return result;

    // To avoid excessive requests triggered by a single URL, cap number of authors
    const maxAuthors = 10;
    const authorKeys: string[] = [];
    let c = 0;

    // Sometimes author IDs are stored together with a "type" identifier
    // in a nested object, sometimes directly. Parse both types.
    for (const authorObj of authorObjArr) {
      if (authorObj.author && typeof authorObj.author.key === 'string') {
        authorKeys.push(authorObj.author.key);
        c++;
      } else if (typeof authorObj.key === 'string') {
        authorKeys.push(authorObj.key);
        c++;
      }
      if (c === maxAuthors) break;
    }
    if (!c) return result;

    const authorLookups = authorKeys.map(authorKey =>
      fetchJSON<OpenLibraryAuthor>(`https://openlibrary.org${authorKey}.json`, {
        timeout: config.adapterTimeout,
        label: 'Open Library author lookup',
        headers: {
          'User-Agent': config.adapterUserAgent,
        },
      })
    );

    const authors = await Promise.all(authorLookups);
    debug.adapters(
      'Received data from Open Library adapter (author lookup):\\n' +
        JSON.stringify(authors, null, 2)
    );

    const authorArray: Array<AdapterMultilingualString> = [];
    for (const author of authors) {
      // These don't seem to differ in practice, even for
      // alternative names, pseudonyms, etc. Our storage
      // of authors is naive for now: we store a single name per author
      // (though we support multiple transliterations).
      const name = author.name || author.personal_name;

      if (name) {
        // We generally don't know what language an author name
        // is transliterated into. Most likely the common Western
        // Latin transliteration. Flag as undetermined.
        // Sanitize: strip tags, decode, then escape to get HTML-safe text
        authorArray.push({ und: escapeHTML(stripTags(decodeHTML(name))) });
      }
    }

    if (authorArray.length) result.authors = authorArray;

    return result;
  }
}
