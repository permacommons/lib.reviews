/* global $ */
import AbstractLookupAdapter from './abstract-lookup-adapter.js';
import { resolveString, validateURL } from '../libreviews.js';
import type { LookupResult, Thing } from '../../types/frontend/adapters.js';

class NativeLookupAdapter extends AbstractLookupAdapter {
  ask(url: string): boolean {
    // Any valid URL can be looked up natively
    return validateURL(url);
  }

  lookup(url: string): Promise<LookupResult> {
    return new Promise((resolve, reject) => {
      $.get('/api/thing', { url, userID: window.config.userID })
        .then(data => {
          const thing: Thing = data.thing;
          const thingURL = thing.urls?.[0];
          const label = resolveString(config.language, thing.label) || thingURL;
          const description = resolveString(config.language, thing.description);
          resolve({
            data: {
              label,
              description,
              thing,
            },
            sourceID: 'native',
          });
        })
        .catch(reject);
    });
  }
}

export default NativeLookupAdapter;
