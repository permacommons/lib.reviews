'use strict';
// Syncs are performed in a shallow manner, that is, they do not create new
// revisions. This is so we can adjust the sync frequency as appropriate
// without accumulating an unwieldy number of revisions.

// Run with DEBUG=libreviews:app to get information about which URLs are being
// contacted, and which slug changes are being performed.

// External deps
const limit = require('promise-limit')(2); // Max 2 URL batch updates at a time
const { initializeDAL } = require('../../bootstrap/dal');
const Thing = require('../../models-postgres/thing');
const debug = require('../../util/debug');

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function syncAll() {
  await initializeDAL();

  const things = await Thing.filterNotStaleOrDeleted().run();
  // Reset sync settings
  things.forEach(thing => thing.setURLs(thing.urls));
  await Promise.all(
    things.map(thing => limit(() => thing.updateActiveSyncs())) // Throttle updates
  );
}

debug.util('Fetching new data and updating search index.');
syncAll()
  .then(() => {
    debug.util('All updates complete.');
    process.exit();
  })
  .catch(error => {
    debug.error('A problem occurred during the synchronization.');
    debug.error({ error });
    process.exit(1);
  });
