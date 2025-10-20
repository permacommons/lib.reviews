// Set up indices and update all reviews and review subjects (things)
'use strict';
const { isDualDatabaseMode, getPostgresDAL } = require('../db-dual');
const search = require('../search');
const debug = require('../util/debug');
const limit = require('promise-limit')(2); // Throttle index updates

// Commonly run from command-line, force output
debug.util.enabled = true;
debug.errorLog.enabled = true;

async function updateIndices() {
  let Thing, Review;
  
  // Determine which models to use based on database configuration
  if (isDualDatabaseMode() && getPostgresDAL()) {
    debug.util('Using PostgreSQL models for indexing');
    const { getPostgresThingModel } = require('../models-postgres/thing');
    const { getPostgresReviewModel } = require('../models-postgres/review');
    Thing = getPostgresThingModel();
    Review = getPostgresReviewModel();
  } else {
    debug.util('Using RethinkDB models for indexing');
    Thing = require('../models/thing');
    Review = require('../models/review');
  }

  if (!Thing || !Review) {
    throw new Error('Could not load Thing and Review models');
  }

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
    process.exit();
  })
  .catch(error => {
    debug.error('Problem updating search indices. The error was:');
    debug.error({
      error
    });
    process.exit(1);
  });