// Set up indices and update all reviews and review subjects (things)

import { initializeDAL } from '../bootstrap/dal.ts';
import search from '../search.js';
import debug from '../util/debug.ts';
import promiseLimit from 'promise-limit';
import Thing from '../models/thing.js';
import Review from '../models/review.js';

const limit = promiseLimit(2); // Throttle index updates

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function updateIndices() {
  await initializeDAL();
  debug.util('Using PostgreSQL models for indexing');

  // Get revisions we need to index & create indices
  // Only get current revisions (not old or deleted)
  const setupResults = await Promise.all([
    Thing.filterNotStaleOrDeleted().run(),
    Review.filterNotStaleOrDeleted().run(),
    search.createIndices()
  ]);
  
  const [things, reviews] = setupResults;
  
  debug.util(`Found ${things.length} things and ${reviews.length} reviews to index`);
  
  let indexUpdates = [
    ...things.map(thing => limit(() => search.indexThing(thing))),
    ...reviews.map(review => limit(() => search.indexReview(review)))
  ];
  
  await Promise.all(indexUpdates);
}

debug.util('Initiating search index update.');
updateIndices()
  .then(() => {
    debug.util('All search indices updated!');
    process.exit(0);
  })
  .catch(error => {
    debug.error('Problem updating search indices. The error was:');
    debug.error({ error });
    process.exit(1);
  });
