/** OpenStreetMap backend adapter (TypeScript).
 * Performs label lookups in OpenStreetMap for ways or nodes, based on the 'name'
 * property in OpenStreetMap and language-specific name tags.
 */

/* External deps */
import config from 'config';
import { decodeHTML } from 'entities';
import escapeHTML from 'escape-html';
import stripTags from 'striptags';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';
import { fetchJSON } from '../util/http.ts';

/* Internal deps */
import AbstractBackendAdapter, {
  type AdapterLookupResult,
  type AdapterMultilingualString,
} from './abstract-backend-adapter.ts';

interface OverpassElement {
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

export default class OpenStreetMapBackendAdapter extends AbstractBackendAdapter {
  constructor() {
    super();

    // Let's break it down:
    // - nodes or ways
    // - ID number
    // - maybe followed by a fragment
    // - case doesn't matter
    this.supportedPattern = /^https:\/\/www.openstreetmap.org\/(node|way)\/(\d+)(?:#.*)?$/i;
    this.supportedFields = ['label'];
    this.sourceID = 'openstreetmap';
    this.sourceURL = 'https://openstreetmap.org/';
    this.throttleMs = 5000; // Wait 5 seconds between OSM requests
  }

  protected async _lookup(url: string): Promise<AdapterLookupResult> {
    const m = url.match(this.supportedPattern);
    if (m === null)
      throw new Error('URL does not appear to reference an OpenStreetMap way or node.');

    // 'way' or 'node'
    const osmType = m[1];
    const osmID = m[2];

    const query = '[out:json];\n' + `${osmType}(${osmID});\n` + 'out;\n';

    const body = new URLSearchParams({ data: query });
    const data = await fetchJSON<OverpassResponse>('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      timeout: config.adapterTimeout,
      label: 'OpenStreetMap',
      headers: {
        'User-Agent': config.adapterUserAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    debug.adapters(
      'Received data from OpenStreetMap adapter (way/node lookup):\n' +
        JSON.stringify(data, null, 2)
    );

    if (typeof data !== 'object' || !data.elements || !data.elements.length)
      throw new Error('Result from OpenStreetMap did not include any data.');

    const first = data.elements[0];
    if (!first.tags) throw new Error(`No tags set for ${osmType} ID: ${osmID}`);

    const tags = first.tags;
    const label: AdapterMultilingualString = {};

    // Names without a language code are stored as 'undetermined' - while those
    // could sometimes be inferred from the country, this is often tricky in practice.
    if (tags['name']) {
      // Sanitize: strip tags, decode, then escape to get HTML-safe text
      label['und'] = escapeHTML(stripTags(decodeHTML(tags['name'])));
    }

    for (const language of languages.getValidLanguages()) {
      // OSM language IDs generally map correctly against lib.reviews. The two notable
      // exceptions are 'pt' (where OSM does not distinguish between Brazilian and
      // European Portuguese) and 'zh' (where OSM does not distinguish between
      // Traditional and Simplified Chinese). We map against the more common variants.
      const key = 'name:' + language;
      if (tags[key]) {
        // Sanitize: strip tags, decode, then escape to get HTML-safe text
        label[language] = escapeHTML(stripTags(decodeHTML(tags[key])));
      }
    }

    if (!Object.keys(label).length)
      throw new Error(`No usable name tag set for ${osmType} ID: ${osmID}`);

    const result: AdapterLookupResult = {
      data: { label },
      sourceID: this.sourceID,
    };
    debug.adapters('result:' + JSON.stringify(result, null, 2));

    return result;
  }
}
