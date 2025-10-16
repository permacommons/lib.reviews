/* global $, config, libreviews */
import AbstractLookupAdapter from './abstract-lookup-adapter';

class NativeLookupAdapter extends AbstractLookupAdapter {

  ask(url) {
    // Any valid URL can be looked up natively
    return libreviews.validateURL(url);
  }

  lookup(url) {
    return new Promise((resolve, reject) => {
      $.get('/api/thing', { url, userID: window.config.userID })
        .then(data => {
          let thing = data.thing;
          let thingURL = thing.urls[0];
          let label = window.libreviews.resolveString(config.language, thing.label) || thingURL;
          let description = window.libreviews.resolveString(config.language, thing.description);
          resolve({
            data: {
              label,
              description,
              thing
            }
          });
        })
        .catch(reject);
    });
  }

}

export default NativeLookupAdapter;
