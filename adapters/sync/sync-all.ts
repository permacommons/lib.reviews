// Syncs are performed in a shallow manner, that is, they do not create new
// revisions. This is so we can adjust the sync frequency as appropriate
// without accumulating an unwieldy number of revisions.

// Run with DEBUG=libreviews:app to get information about which URLs are being
// contacted, and which slug changes are being performed.

import promiseLimit from 'promise-limit';
import { initializeDAL } from '../../bootstrap/dal.ts';
import type { ThingInstance } from '../../models/manifests/thing.ts';
import Thing from '../../models/thing.js';
import debug from '../../util/debug.ts';

const limit = promiseLimit<unknown>(2); // Max 2 URL batch updates at a time

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function syncAll(): Promise<void> {
  await initializeDAL();
  const things = (await Thing.filterWhere({}).run()) as ThingInstance[];

  // Reset sync settings to ensure model-side mutations are applied consistently.
  for (const thing of things) {
    thing.setURLs(thing.urls);
  }

  await Promise.all(
    things.map(thing => limit(() => thing.updateActiveSyncs())) // Throttle updates
  );
}

debug.util('Fetching new data and updating search index.');
syncAll()
  .then(() => {
    debug.util('All updates complete.');
    process.exit(0);
  })
  .catch((error: unknown) => {
    debug.error('A problem occurred during the synchronization.');
    const detail = error instanceof Error ? error : new Error(String(error));
    debug.error(detail);
    process.exit(1);
  });
