import type { LookupResult } from '../../types/frontend/adapters.js';
import $ from '../lib/jquery.js';
import AbstractLookupAdapter from './abstract-lookup-adapter.js';

interface OverpassElement {
  tags?: {
    name?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  [key: string]: any;
}

class OpenStreetMapLookupAdapter extends AbstractLookupAdapter {
  constructor(updateCallback?: Function | null) {
    super(updateCallback);
    this.sourceID = 'openstreetmap';
    this.supportedPattern = /^https:\/\/www.openstreetmap.org\/(node|way)\/(\d+)(?:#.*)?$/i;
  }

  lookup(url: string): Promise<LookupResult> {
    return new Promise((resolve, reject) => {
      const m = url.match(this.supportedPattern!);
      if (m === null)
        return reject(new Error('URL does not appear to reference an OpenStreetMap node or way.'));

      const type = m[1];
      const id = m[2];

      const query = '[out:json];\n' + `${type}(${id});\n` + 'out;\n';

      $.post('https://overpass-api.de/api/interpreter', {
        data: query,
      })
        .then((data: OverpassResponse) => {
          if (typeof data != 'object' || !data.elements || !data.elements.length)
            return reject(new Error(`No OpenStreetMap data received for ${type} ID: ${id}`));

          if (!data.elements[0].tags || !data.elements[0].tags.name)
            return reject(new Error(`No name set for ${type} ID: ${id}`));

          resolve({
            data: {
              label: data.elements[0].tags.name,
            },
            sourceID: this.sourceID!,
          });
        })
        .catch(reject);
    });
  }
}

export default OpenStreetMapLookupAdapter;
