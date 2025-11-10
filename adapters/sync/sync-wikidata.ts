// Syncs are performed in a shallow manner, that is, they do not create new
// revisions. This is so we can adjust the sync frequency as appropriate
// without accumulating an unwieldy number of revisions.

import promiseLimit from 'promise-limit';
import { initializeDAL } from '../../bootstrap/dal.ts';
import Thing from '../../models/thing.js';
import search from '../../search.ts';
import type { AdapterLookupResult } from '../abstract-backend-adapter.ts';
import WikidataBackendAdapter from '../wikidata-backend-adapter.ts';

interface DescriptionSyncState {
  active?: boolean;
  source?: string;
  updated?: Date;
  [key: string]: unknown;
}

interface WikidataThing {
  urls?: string[];
  metadata?: Record<string, unknown>;
  sync?: {
    description?: DescriptionSyncState;
    [key: string]: unknown;
  };
  save(): Promise<unknown>;
}

type IndexableThing = Parameters<typeof search.indexThing>[0];

const wikidata = new WikidataBackendAdapter();
const limit = promiseLimit<AdapterLookupResult>(4); // Max 4 concurrent requests

// URL pattern a thing needs to have among its .urls to enable and perform
// sync for descriptions. This is identical to the one used by the adapter.
const wikidataURLPattern = /^http(s)*:\/\/(www.)*wikidata.org\/(entity|wiki)\/(Q\d+)$/;

async function syncWikidata(): Promise<void> {
  await initializeDAL();
  const allThings = (await Thing.filterWhere({}).run()) as WikidataThing[];

  const wikidataThings = allThings.filter(
    thing => Array.isArray(thing.urls) && thing.urls.some(url => wikidataURLPattern.test(url))
  );

  const lookupTasks: Array<Promise<AdapterLookupResult | null>> = wikidataThings.map(
    async thing => {
      const wikidataURL = getWikidataURL(thing.urls);
      if (!wikidataURL) {
        return null;
      }

      if (!thing.sync) {
        thing.sync = {};
      }
      const descriptionSync =
        thing.sync.description ??
        (thing.sync.description = {
          active: true,
          source: 'wikidata',
        });
      descriptionSync.active = descriptionSync.active !== false;

      return limit(() => wikidata.lookup(wikidataURL));
    }
  );

  const wikidataResults = await Promise.all(lookupTasks);

  const updates: Array<Promise<IndexableThing>> = [];
  wikidataThings.forEach((thing, index) => {
    const descriptionSync = thing.sync?.description;
    const result = wikidataResults[index];
    const adapterDescription = result?.data?.description;

    if (descriptionSync?.active && adapterDescription) {
      if (!thing.metadata) {
        thing.metadata = {};
      }
      thing.metadata.description = adapterDescription;
      descriptionSync.updated = new Date();
      descriptionSync.source = 'wikidata';
      updates.push(thing.save() as Promise<IndexableThing>);
    }
  });

  const updatedThings = await Promise.all(updates);
  console.log(`Sync complete. ${updatedThings.length} items updated.`);
  console.log('Updating search index now.');

  await Promise.all(updatedThings.map(record => search.indexThing(record)));
  console.log('Search index updated.');
}

// From an array of URLs, return the first one (if any) that matches the
// Wikidata regular expression.
function getWikidataURL(urls?: readonly string[]): string | undefined {
  if (!urls) {
    return undefined;
  }
  for (const url of urls) {
    if (wikidataURLPattern.test(url)) {
      return url;
    }
  }
  return undefined;
}

syncWikidata()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Problem performing Wikidata sync:', error);
    process.exit(1);
  });
