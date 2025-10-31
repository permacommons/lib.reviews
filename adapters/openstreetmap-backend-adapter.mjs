// This module performs label lookups in OpenStreetMap for ways or nodes, based
// on the 'name' property in OpenStreetMap.

// External deps
import config from 'config';
import escapeHTML from 'escape-html';
import debug from '../util/debug.mjs';
import { fetchJSON } from '../util/http.js';
import languages from '../locales/languages.js';

const validLanguages = languages.getValidLanguages();

// Internal deps
import AbstractBackendAdapter from './abstract-backend-adapter.mjs';

export default class OpenStreetMapBackendAdapter extends AbstractBackendAdapter {

  constructor() {
    super();

    // Let's break it down:
    // - nodes or ways
    // - ID number
    // - maybe followed by a fragment
    // - case doesn't matter
    this.supportedPattern =
      new RegExp('^https://www.openstreetmap.org/(node|way)/(\\d+)(?:#.*)?$', 'i');
    this.supportedFields = ['label'];
    this.sourceID = 'openstreetmap';
    this.sourceURL = 'https://openstreetmap.org/';
  }

  async lookup(url) {
    const m = url.match(this.supportedPattern);
    if (m === null)
      throw new Error('URL does not appear to reference an OpenStreetMap way or node.');

    // 'way' or 'node'
    const osmType = m[1];
    const osmID = m[2];

    const query =
      '[out:json];\n' +
      `${osmType}(${osmID});\n` +
      'out;\n';

    const body = new URLSearchParams({ data: query });
    const data = await fetchJSON('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      timeout: config.adapterTimeout,
      label: 'OpenStreetMap',
      headers: {
        'User-Agent': config.adapterUserAgent,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    debug.adapters('Received data from OpenStreetMap adapter (way/node lookup):\n' +
      JSON.stringify(data, null, 2));

    if (typeof data !== 'object' || !data.elements || !data.elements.length)
      throw new Error('Result from OpenStreetMap did not include any data.');

    if (!data.elements[0].tags)
      throw new Error(`No tags set for ${osmType} ID: ${osmID}`);


    const tags = data.elements[0].tags;
    const label = {};

    // Names without a language code are stores as 'undetermined' - while those
    // could sometimes be inferred from the country, this is often tricky in
    // practice.
    if (tags['name']) {
      label['und'] = escapeHTML(tags['name']);
    }

    for (let language of validLanguages) {
      // OSM language IDs map correctly against lib.reviews. The two notable
      // exceptions are 'pt' (where OSM does not appear to distinguish between
      // Brazilian and European Portuguese) and 'zh' (where OSM does not appear
      // to distinguish between Traditional and Simplified Chinese). In both
      // cases we're mapping against the more common (Brazilian Portuguese,
      // Simplified Chinese).
      if (tags['name:' + language]) {
        label[language] = tags['name:' + language];
      }
    }

    if (!Object.keys(label).length)
      throw new Error(`No usable name tag set for ${osmType} ID: ${osmID}`);

    const result = {
      data: {
        label
      },
      sourceID: this.sourceID
    };
    debug.adapters('result:' + JSON.stringify(result, null, 2));

    return result;
  }

}
