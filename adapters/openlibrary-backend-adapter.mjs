// This module performs book metadata lookups in Open Library, including title,
// subtitle and authorship information. Language of text strings may be set
// to undetermined ('und'), since such language information is not consistently
// present in the source.

// External deps
import config from 'config';
import escapeHTML from 'escape-html';
import debug from '../util/debug.mjs';
import { fetchJSON } from '../util/http.mjs';

// Internal deps
import AbstractBackendAdapter from './abstract-backend-adapter.mjs';

// OL uses ISO639-3 codes.
const openLibraryToNative = {
  'eng': 'en',
  'ben': 'bn',
  'ger': 'de',
  'esp': 'eo',
  'spa': 'es',
  'fre': 'fr',
  'hun': 'hu',
  'ita': 'it',
  'jpn': 'ja',
  'mac': 'mk',
  'dut': 'nl',
  'por': 'pt', // OL code does not disambiguate, assumed to be Brazilian Portuguese
  'swe': 'sv',
  'chi': 'zh' // OL code does not disambiguate, assumed to be Simplified Chinese
};

export default class OpenLibraryBackendAdapter extends AbstractBackendAdapter {

  constructor() {
    super();

    // Let's break it down:
    // - HTTP or HTTPS
    // - works or books (not authors or other stuff on the site)
    // - OL<anything except "." or "/">
    // - maybe followed by a slash, and maybe some more stuff after that
    // - which we don't care about hence the non-capturing groups (?:
    // - case doesn't matter
    this.supportedPattern =
    new RegExp('^https*://openlibrary.org/(works|books)/(OL[^/.]+)(?:/(?:.*))*$', 'i');
    this.supportedFields = ['label', 'authors', 'subtitle'];
    this.sourceID = 'openlibrary';
    this.sourceURL = 'https://openlibrary.org/';
  }

  async lookup(url) {
    const m = url.match(this.supportedPattern);
    if (m === null)
      throw new Error('URL does not appear to reference an Open Library work or edition.');

    // Open Library distinguishes works and editions. Editions contain
    // significantly more metadata and are generally preferred. We cannot
    // guess the edition, however -- even if only on 1 exists in Open Library,
    // others may exist in the world.
    const isEdition = m[1] == 'books';

    // The string at the end of the original URL must be striped off for
    // obtaining the JSON representation.
    const jsonURL = isEdition ? `https://openlibrary.org/books/${m[2]}.json` :
      `https://openlibrary.org/works/${m[2]}.json`;

    const data = await fetchJSON(jsonURL, {
      timeout: config.adapterTimeout,
      label: 'Open Library',
      headers: {
        'User-Agent': config.adapterUserAgent
      }
    });
    debug.adapters('Received data from Open Library adapter (book/edition lookup):\n' +
      JSON.stringify(data, null, 2));

    if (typeof data !== 'object' || !data.title)
      throw new Error('Result from Open Library did not include a work or edition title.');

    let language = 'und'; // undetermined language, which is a valid key for storage

    if (Array.isArray(data.languages) && data.languages.length) {
      const languageKey = data.languages[0].key;
      const code = (languageKey.match(new RegExp('/languages/(.*)')) || [])[1];
      language = openLibraryToNative[code] || language;
    }

    const result = {
      data: {},
      sourceID: this.sourceID
    };

    result.data.label = {
      [language]: escapeHTML(data.title)
    };
    if (data.subtitle)
      result.data.subtitle = {
        [language]: escapeHTML(data.subtitle)
      };

    let authors;
    try {
      authors = await this.getAuthors(data.authors);
    } catch (error) {
      debug.error({ error });
      return result;
    }
    Object.assign(result.data, authors);
    return result;
  }

  // Promise to retrieve a set of authors from the keys specified in a work or
  // edition. Requires the object array from the work or edition record.
  // Does not catch lookup failures.
  async getAuthors(authorObjArr) {
    const result = {};

    if (!Array.isArray(authorObjArr) || !authorObjArr.length)
      return result;

    // To avoid excessive requests triggered by a single URL, for now
    // we cap the number of authors
    const maxAuthors = 10;
    const authorKeys = [];
    let c = 0;

    // Sometimes author IDs are stored together with a "type" identifier
    // in a nested object, sometimes directly. We parse both types.
    for (let authorObj of authorObjArr) {
      if (typeof authorObj.author == 'object' &&
        typeof authorObj.author.key == 'string') {
        authorKeys.push(authorObj.author.key);
        c++;
      } else if (typeof authorObj.key == 'string') {
        authorKeys.push(authorObj.key);
        c++;
      }
      if (c == maxAuthors)
        break;
    }
    if (!c)
      return result;

    const authorLookups = [];
    for (let authorKey of authorKeys) {
      authorLookups.push(fetchJSON(`https://openlibrary.org${authorKey}.json`, {
        timeout: config.adapterTimeout,
        label: 'Open Library author lookup',
        headers: {
          'User-Agent': config.adapterUserAgent
        }
      }));
    }
    const authors = await Promise.all(authorLookups);
    debug.adapters('Received data from Open Library adapter (author lookup):\n' +
      JSON.stringify(authors, null, 2));

    const authorArray = [];
    for (let author of authors) {

      // These don't seem to differ in practice, even for
      // alternative names, pseudonyms, etc. Our storage
      // of authors is naive, for now, in any case -- we store
      // a single name per author (though we support multiple
      // transliterations of that name, while OL does not).
      let name = author.name || author.personal_name;

      if (name)
        // We generally don't know what language an author name
        // is transliterated into -- the work/edition does not
        // really tell us. Most likely it is the common Western
        // Latin transliteration. We flag this as undetermined.
        authorArray.push({ 'und': escapeHTML(name) });
    }
    if (authorArray.length)
      result.authors = authorArray;
    return result;

  }

}
