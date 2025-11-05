// Set up indices and update all reviews and review subjects (things)

import promiseLimit from 'promise-limit';
import { initializeDAL } from '../bootstrap/dal.ts';
import Review from '../models/review.js';
import Thing from '../models/thing.js';
import search from '../search.ts';
import debug from '../util/debug.ts';

type IndexableThing = Parameters<typeof search.indexThing>[0];
type IndexableReview = Parameters<typeof search.indexReview>[0];

const limit = promiseLimit<unknown>(2); // Throttle index updates

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function updateIndices(): Promise<void> {
  await initializeDAL();
  debug.util('Using PostgreSQL models for indexing');

  // Get revisions we need to index & create indices
  // Only get current revisions (not old or deleted)
  const createIndicesPromise = search.createIndices();
  const [things, reviews] = await Promise.all([
    Thing.filterNotStaleOrDeleted().run() as Promise<IndexableThing[]>,
    Review.filterNotStaleOrDeleted().run() as Promise<IndexableReview[]>,
  ]);
  await createIndicesPromise;

  debug.util(`Found ${things.length} things and ${reviews.length} reviews to index`);

  const indexUpdates: Array<Promise<unknown>> = [
    ...things.map(thing => limit(() => search.indexThing(thing))),
    ...reviews.map(review => limit(() => search.indexReview(review))),
  ];

  await Promise.all(indexUpdates);
}

debug.util('Initiating search index update.');
updateIndices()
  .then(() => {
    debug.util('All search indices updated!');
    process.exit(0);
  })
  .catch((error: unknown) => {
    debug.error('Problem updating search indices. The error was:');
    const detail = error instanceof Error ? error : new Error(String(error));
    debug.error(detail);
    process.exit(1);
  });
