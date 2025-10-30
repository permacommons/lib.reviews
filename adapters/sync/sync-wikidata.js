'use strict';

// Syncs are performed in a shallow manner, that is, they do not create new
// revisions. This is so we can adjust the sync frequency as appropriate
// without accumulating an unwieldy number of revisions.

// External deps
const limit = require('promise-limit')(4); // Max 4 concurrent requests

// Internal deps
const { initializeDAL } = require('../../bootstrap/dal');
const WikidataBackendAdapter = require('../wikidata-backend-adapter');
const wikidata = new WikidataBackendAdapter();
const Thing = require('../../models/thing');
const search = require('../../search');

// URL pattern a thing needs to have among its .urls to enable and perform
// sync for descriptions. This is identical to the one used by the
// adapter, but keep in mind that RethinkDB uses RE2 expressions, not JS ones.
const regexStr = '^http(s)*://(www.)*wikidata.org/(entity|wiki)/(Q\\d+)$';

async function syncWikidata() {
  await initializeDAL();

  const allThings = await Thing.filterNotStaleOrDeleted().run();

  const wikidataThings = allThings.filter(thing =>
    thing.urls && thing.urls.some(url => new RegExp(regexStr).test(url))
  );

  const lookupTasks = wikidataThings.map(thing => {
    const wikidataURL = getWikidataURL(thing.urls);
    if (!wikidataURL) {
      return Promise.resolve(null);
    }

    if (!thing.sync) {
      thing.sync = {};
    }
    if (!thing.sync.description) {
      thing.sync.description = {
        active: true,
        source: 'wikidata'
      };
    }

    return limit(() => wikidata.lookup(wikidataURL));
  });

  const wikidataResults = await Promise.all(lookupTasks);

  const updates = [];
  wikidataThings.forEach((thing, index) => {
    const syncActive = thing.sync && thing.sync.description && thing.sync.description.active;
    const result = wikidataResults[index];
    const hasDescription = result?.data?.description;

    if (syncActive && hasDescription) {
      if (!thing.metadata) {
        thing.metadata = {};
      }
      thing.metadata.description = result.data.description;
      thing.sync.description.updated = new Date();
      thing.sync.description.source = 'wikidata';
      updates.push(thing.save());
    }
  });

  const updatedThings = await Promise.all(updates);
  console.log(`Sync complete. ${updatedThings.length} items updated.`);
  console.log('Updating search index now.');

  await Promise.all(updatedThings.map(search.indexThing));
  console.log('Search index updated.');
}

// From an array of URLs, return the first one (if any) that matches the
// Wikidata regular expression.
function getWikidataURL(arr) {
  const r = new RegExp(regexStr);
  for (const url of arr) {
    if (r.test(url)) {
      return url;
    }
  }
  return null;
}

syncWikidata()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Problem performing Wikidata sync:', error);
    process.exit(1);
  });
