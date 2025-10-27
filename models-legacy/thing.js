'use strict';

/**
 * Model for review subjects, including metadata such as URLs, author names,
 * business hours, etc.
 *
 * @namespace Thing
 */

const thinky = require('../db');
const r = thinky.r;
const type = thinky.type;

const urlUtils = require('../util/url-utils');
const debug = require('../util/debug');
const mlString = require('./helpers/ml-string');
const revision = require('./helpers/revision');
const slugName = require('./helpers/slug-name');
const getSetIDHandler = require('./helpers/set-id');
const File = require('./file');
const ThingSlug = require('./thing-slug');
const isValidLanguage = require('../locales/languages').isValid;
const ReportedError = require('../util/reported-error');
const adapters = require('../adapters/adapters');
const search = require('../search');

let thingSchema = {

  id: type.string(),

  // First element is primary URL associated with this thing
  urls: [type.string().validator(_isValidURL)],

  label: mlString.getSchema({
    maxLength: 256
  }),

  aliases: mlString.getSchema({
    maxLength: 256,
    array: true
  }),

  description: mlString.getSchema({
    maxLength: 512
  }),

  // Many creative works have a subtitle that we don't typically include as part
  // of the label.
  subtitle: mlString.getSchema({
    maxlength: 256
  }),

  // For creative works like books, magazine articles. Author names can be
  // transliterated, hence also a multilingual field. However, it is advisable
  // to treat it as monolingual in presentation (i.e. avoid indicating language),
  // since cross-language differences are the exception and not the norm.
  authors: [mlString.getSchema({
    maxLength: 256
  })],


  // Data for fields can be pulled from external sources. For fields that
  // support this, we record whether a sync is currently active (in which
  // case the field is not editable), when the last sync took place,
  // and from where.
  //
  // Note we don't initialize the "active" property -- if (and only if) it is
  // undefined, it may be switched on by the /adapters/sync scripts.
  sync: {
    description: {
      active: type.boolean(),
      updated: type.date(),
      source: type.string().enum(['wikidata'])
    }
  },

  originalLanguage: type
    .string()
    .max(4)
    .validator(isValidLanguage),

  canonicalSlugName: type.string(),

  urlID: type.virtual().default(function() {
    return this.canonicalSlugName ? encodeURIComponent(this.canonicalSlugName) : this.id;
  }),

  // Track original authorship across revisions
  createdOn: type.date().required(true),
  createdBy: type.string().uuid(4).required(true),

  // These can only be populated from the outside using a user object
  userCanDelete: type.virtual().default(false),
  userCanEdit: type.virtual().default(false),
  userCanUpload: type.virtual().default(false),
  userIsCreator: type.virtual().default(false),

  // Populated asynchronously using the populateReviewMetrics method
  numberOfReviews: type.virtual().default(0),
  averageStarRating: type.virtual().default(0)
};

// Add versioning related fields
Object.assign(thingSchema, revision.getSchema());

let Thing = thinky.createModel("things", thingSchema);

Thing.hasAndBelongsToMany(File, "files", "id", "id", {
  type: 'media_usage'
});

File.hasAndBelongsToMany(Thing, "things", "id", "id", {
  type: 'media_usage'
});

Thing.hasOne(ThingSlug, "slug", "id", "thingID");

ThingSlug.belongsTo(Thing, "thing", "thingID", "thing");

// NOTE: STATIC METHODS --------------------------------------------------------

// Standard handlers -----------------------------------------------------------

Thing.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(Thing);
Thing.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(Thing);

// Custom methods --------------------------------------------------------------

/**
 * Find a Thing object using a URL. May return multiple matches (but ordinarily
 * should not).
 *
 * @param {String} url
 *  the URL to look up
 * @param {String} [userID]
 *  include any review(s) of this thing by the given user
 * @returns {Query}
 *  query for current revisions that contain this URL
 */
Thing.lookupByURL = function(url, userID) {
  let query = Thing
    .filter(thing => thing('urls').contains(url))
    .filter({ _oldRevOf: false }, { default: true })
    .filter({ _revDeleted: false }, { default: true });

  if (typeof userID == 'string')
    query = query.getJoin({
      reviews: {
        _apply: seq => seq
          .filter({ createdBy: userID })
          .filter({ _oldRevOf: false }, { default: true })
          .filter({ _revDeleted: false }, { default: true })
      }
    });

  return query;

};

/**
 * Get a Thing object by ID, plus some of the data linked to it.
 *
 * @async
 * @param {String} id
 *  the unique ID of the Thing object
 * @param {Object} [options]
 *  which data to include
 * @param {Boolean} options.withFiles=true
 *  include metadata about file upload via join
 * @param {Boolean} options.withReviewMetrics=true
 *  obtain review metrics (e.g., average rating); requires additional table
 *  lookup
 * @returns {Thing}
 *  the Thing object
 */
Thing.getWithData = async function(id, {
  // First-level joins
  withFiles = true,
  withReviewMetrics = true
} = {}) {

  let join;
  if (withFiles)
    join = {
      files: {
        uploader: true,
        _apply: seq => seq
          .filter({ completed: true }) // We don't show unfinished uploads
          .filter({ _revDeleted: false }, { default: true })
          .filter({ _oldRevOf: false }, { default: true })
      }
    };

  const thing = await Thing.getNotStaleOrDeleted(id, join);
  if (thing._revDeleted)
    throw revision.deletedError;

  if (thing._oldRevOf)
    throw revision.staleError;

  if (withReviewMetrics)
    await thing.populateReviewMetrics();

  return thing;
};

/**
 * Get label for a given thing in the provided language, or fall back to a
 * prettified URL.
 *
 * @param  {Thing} thing
 *  the thing object to get a label for
 * @param  {String} language
 *  the language code of the preferred language
 * @returns {String}
 *  the best available label
 */
Thing.getLabel = function(thing, language) {

  if (!thing || !thing.id)
    return undefined;

  let str;
  if (thing.label)
    str = mlString.resolve(language, thing.label).str;

  if (str)
    return str;

  // If we have no proper label, we can at least show the URL
  if (thing.urls && thing.urls.length)
    return urlUtils.prettify(thing.urls[0]);

  return undefined;

};

// INSTANCE METHODS ------------------------------------------------------------

// Standard handlers -----------------------------------------------------------

// See helpers/revision.js
Thing.define("newRevision", revision.getNewRevisionHandler(Thing));
Thing.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(Thing));

// See helpers/slug-name.js
Thing.define("updateSlug", slugName.getUpdateSlugHandler({
  SlugModel: ThingSlug,
  slugForeignKey: 'thingID',
  slugSourceField: 'label'
}));

// See helpers/set-id.js
Thing.define("setID", getSetIDHandler());

// Custom methods --------------------------------------------------------------

Thing.define("initializeFieldsFromAdapter", initializeFieldsFromAdapter);
Thing.define("populateUserInfo", populateUserInfo);
Thing.define("populateReviewMetrics", populateReviewMetrics);
Thing.define("setURLs", setURLs);
Thing.define("updateActiveSyncs", updateActiveSyncs);
Thing.define("getSourceIDsOfActiveSyncs", getSourceIDsOfActiveSyncs);
Thing.define("getReviewsByUser", getReviewsByUser);
Thing.define("getAverageStarRating", getAverageStarRating);
Thing.define("getReviewCount", getReviewCount);
Thing.define("addFile", addFile);
Thing.define("addFilesByIDsAndSave", addFilesByIDsAndSave);

/**
 * Initialize field values from the lookup result of an adapter. Each adapter
 * has a whitelist of supported fields which we check against before assigning
 * values to the thing instance.
 *
 * This function does not save and can therefore run synchronously.
 * It resets all sync settings (whether a sync for a given field is active or
 * not), so it should only be invoked on new Thing objects.
 *
 * Silently ignores empty results.
 *
 * @param {Object} adapterResult
 *  the result from any backend adapter
 * @param {Object} adapterResult.data
 *  data for this result
 * @param {String} adapterResult.sourceID
 *  canonical source identifier
 * @throws
 *  on malformed adapterResult object
 * @instance
 * @memberof Thing
 */
function initializeFieldsFromAdapter(adapterResult) {
  if (typeof adapterResult != 'object')
    return;

  let responsibleAdapter = adapters.getAdapterForSource(adapterResult.sourceID);
  let supportedFields = responsibleAdapter.getSupportedFields();
  for (let field in adapterResult.data) {
    if (supportedFields.includes(field)) {
      this[field] = adapterResult.data[field];
      if (typeof this.sync != 'object')
        this.sync = {};
      this.sync[field] = {
        active: true,
        source: adapterResult.sourceID,
        updated: new Date()
      };
    }
  }
}

/**
 * Populate virtual permission fields in a Thing object with the rights of a
 * given user.
 *
 * @param {User} user
 *  the user whose permissions to check
 * @memberof Thing
 * @instance
 */
function populateUserInfo(user) {
  if (!user)
    return; // Permissions will be at their default value (false)

  // For now, we don't let users delete things they've created,
  // since things are collaborative in nature
  this.userCanDelete = user.isSuperUser || user.isSiteModerator || false;
  this.userCanEdit = user.isSuperUser || user.isTrusted || user.id === this.createdBy;
  this.userCanUpload = user.isSuperUser || user.isTrusted;
  this.userIsCreator = user.id === this.createdBy;
}

/**
 * Set this Thing object's virtual data fields for review metrics (performs
 * table lookups, hence asynchronous). Does not save.
 *
 * @returns {Thing}
 *  the modified thing object
 * @memberof Thing
 * @instance
 */
async function populateReviewMetrics() {
  const [averageStarRating, numberOfReviews] = await Promise.all([
    this.getAverageStarRating(),
    this.getReviewCount()
  ]);
  this.averageStarRating = averageStarRating;
  this.numberOfReviews = numberOfReviews;
  return this;
}

/**
 * Update URLs and reset a Thing object's synchronization settings, based on
 * which adapters report that they can retrieve external metadata for a given
 * URL. Does not save.
 *
 * @param  {String[]} urls
 *  the *complete* array of URLs to assign (previously assigned URLs will be
 *  overwritten)
 * @instance
 * @memberof Thing
 */
function setURLs(urls) {

  // Turn off all synchronization
  if (typeof this.sync == 'object') {
    for (let field in this.sync) {
      this.sync[field].active = false;
    }
  }

  // Turn on synchronization for supported fields. The first adapter
  // from the getAll() array to claim a supported field will be responsible
  // for it. The order of the URLs also matters -- adapters handling earlier
  // URLs can claim fields before adapters handling later URLs get to them.
  // We could change the order to enforce precedence, but for now, we leave
  // it up to the editor.
  urls.forEach(url => {
    adapters.getAll().forEach(adapter => {
      if (adapter.ask(url)) {
        adapter.supportedFields.forEach(field => {
          // Another adapter is already handling this field
          if (this.sync && this.sync[field] && this.sync[field].active)
            return;
          if (!this.sync)
            this.sync = {};

          this.sync[field] = {
            active: true,
            source: adapter.sourceID
          };
        });
      }
    });
  });
  this.urls = urls;
}

/**
 * Fetch new external data for all fields set to be synchronized. Saves.
 * - Does not create a new revision, so if you need one, create it first.
 * - Performs search index update.
 * - Resolves with updated thing object.
 * - May result in a slug update, so if initiated by a user, should be passed the
 *   user ID. Otherwise, any slug changes will be without attribution
 *
 * @param {String} userID
 *  the user to associate with any slug changes
 * @returns {Thing}
 *  the updated thing
 * @memberof Thing
 * @instance
 */
async function updateActiveSyncs(userID) {
  const thing = this; // For readability

  // No URLs? Just give the thing back.
  if (!thing.urls || !thing.urls.length)
    return thing;

  // No known syncs? We'll still fall through to the save/index operation at
  // the end.
  if (typeof thing.sync !== 'object')
    thing.sync = {};

  // Determine which external sources we need to contact. While one source
  // may give us updates for many fields, we obviously only want to contact
  // it once.
  let sources = [];
  for (let field in thing.sync) {
    if (thing.sync[field].active && thing.sync[field].source &&
      !sources.includes(thing.sync[field].source))
      sources.push(thing.sync[field].source);
  }

  //  Build array of lookup promises from currently used sources
  let p = [];

  // Keep track of all URLs we're contacting for convenience
  let allURLs = [];

  sources.forEach(source => {
    let adapter = adapters.getAdapterForSource(source);
    // Find all matching URLs in array (we might have, e.g., a URL for
    // a work and one for an edition, and need to contact both).
    let relevantURLs = thing.urls.filter(url => adapter.ask(url));
    allURLs = allURLs.concat(relevantURLs);
    // Add relevant lookups as individual elements to array, log errors
    p.push(...relevantURLs.map(url =>
      adapter
      .lookup(url)
      .catch(error => {
        debug.error(`Problem contacting adapter "${adapter.getSourceID()}" for URL ${url}.`);
        debug.error({ error });
      })
    ));
  });

  if (allURLs.length)
    debug.app(`Retrieving item metadata for ${thing.id} from the following URL(s):\n` +
      allURLs.join(', '));

  // Perform all lookups, then update thing from the results, which will be
  // returned in the same order as the sources array.
  const results = await Promise.all(p);

  // If the label has changed, we need to update the short identifier
  // (slug). This means a possible URL change! Redirects are put in
  // place automatically.
  let needSlugUpdate;

  // Get obj w/ key = source ID, value = reverse order array of
  // result.data objects
  let dataBySource = _organizeDataBySource(results);
  sources.forEach((source) => {
    for (let field in thing.sync) {
      // Only update if everything looks good: sync is active, source
      // ID matches, we may have new data
      if (thing.sync[field].active && thing.sync[field].source === source &&
        Array.isArray(dataBySource[source])) {
        // Earlier results get priority, i.e. need to be assigned last
        for (let d of dataBySource[source]) {
          if (d[field] !== undefined) {
            thing.sync[field].updated = new Date();
            this[field] = d[field];
            if (field == 'label')
              needSlugUpdate = true;
          }
        }
      }
    }
  });

  if (needSlugUpdate)
    await thing.updateSlug(userID, thing.originalLanguage || 'en');

  await thing.save();

  // Index update can keep running after we resolve this promise, hence no "await"
  search.indexThing(thing);

  return thing;


  /**
   * Put valid data from results array into an object with sourceID as
   * the key and data as a reverse-order array. There may be multiple
   * URLs from one source, assigning value to the same field. URLs earlier
   * in the original thing.urls array take priority, so we have to ensure
   * they come last.
   *
   * @param {Object[]} results
   *  results from multiple adapters
   * @returns {Object}
   *  key = source, value = array of data objects
   * @memberof Thing
   * @inner
   * @protected
   */
  function _organizeDataBySource(results) {
    let rv = {};
    results.forEach(result => {
      // Correctly formatted result object with all relevant information
      if (typeof result == 'object' && typeof result.sourceID == 'string' &&
        typeof result.data == 'object') {
        // Initialize array if needed
        if (!Array.isArray(rv[result.sourceID]))
          rv[result.sourceID] = [];

        // See above on why this array is in reverse order
        rv[result.sourceID].unshift(result.data);
      }
    });
    return rv;
  }

}

/**
 * Get the identifiers of all sources for which relevant information is being
 * fetched for this review subject.
 *
 * @returns {String[]}
 *  array of the source IDs
 */
function getSourceIDsOfActiveSyncs() {
  const sync = this.sync;
  const rv = [];
  for (let key in sync) {
    if (sync[key] && sync[key].active && sync[key].source && !rv.includes(sync[key].source))
      rv.push(sync[key].source);
  }
  return rv;
}

/**
 * Get all reviews by the given user for this thing. The number is typically
 * 1, but there may be edge cases or bugs where a user will have multiple
 * reviews for the same thing.
 *
 * @param {User} user
 *  the user whose reviews we're looking up for this thing
 * @returns {Array}
 *  array of the reviews
 * @instance
 * @memberof Thing
 */
async function getReviewsByUser(user) {

  let Review = require('./review');

  if (!user)
    return [];

  const reviews = await Review
    .filter({
      thingID: this.id,
      createdBy: user.id
    })
    .filter(r.row('_revDeleted').eq(false), { // Exclude deleted rows
      default: true
    })
    .filter(r.row('_oldRevOf').eq(false), { // Exclude old revisions
      default: true
    })
    .getJoin({
      creator: {
        _apply: seq => seq.without('password')
      },
      teams: true
    });
  reviews.forEach(review => review.populateUserInfo(user));
  return reviews;
}

/**
 * Calculate the average review rating for this Thing object
 *
 * @returns {Number}
 *  average rating, not rounded
 * @memberof Thing
 * @instance
 */
async function getAverageStarRating() {
  try {
    return await r.table('reviews')
      .filter({ thingID: this.id })
      .filter({ _oldRevOf: false }, { default: true })
      .filter({ _revDeleted: false }, { default: true })
      .avg('starRating');
  } catch (error) {
    // Throws if the stream is empty. We consider a subject with 0 reviews
    // to have an average rating of 0.
    if (error.name == 'ReqlRuntimeError')
      return 0;
    else
      throw error;
  }
}

/**
 * Count the number of reviews associated with this Thing object (discounting
 * old/deleted revisions).
 *
 * @returns {Number}
 *  the number of reviews
 * @memberof Thing
 * @instance
 */
async function getReviewCount() {
  return await r.table('reviews')
    .filter({ thingID: this.id })
    .filter({ _oldRevOf: false }, { default: true })
    .filter({ _revDeleted: false }, { default: true })
    .count();
}

/**
 * Simple helper method to initialize files array for a Thing object if it does
 * not exist already, and then add a file.
 *
 * @param {File} file
 *  File object to add
 * @memberof Thing
 * @instance
 */
function addFile(file) {
  if (this.files === undefined)
    this.files = [];

  this.files.push(file);
}


/**
 * Obtain file objects for an array of file IDs, and associate them with this
 * thing. Saves.
 *
 * @param {String[]} files
 *  IDs of the files to add
 * @param {String} [userID]
 *  if given, uploader must match this user ID. Mismatches are silently ignored.
 * @memberof Thing
 * @instance
 */
async function addFilesByIDsAndSave(files, userID) {
  const fileRevs = await File
    .getAll(...files)
    .filter({ _revDeleted: false }, { default: true })
    .filter({ _oldRevOf: false }, { default: true });
  fileRevs.forEach(fileRev => {
    if (!userID || fileRev.uploadedBy === userID)
      this.addFile(fileRev);
  });
  await this.saveAll({ files: true });
}

// Internal helper functions

/**
 * @param {String} url
 *  URL to check
 * @returns {Boolean}
 *  true if valid
 * @throws {ReportedError}
 *  if invalid
 * @memberof Thing
 * @protected
 */
function _isValidURL(url) {
  if (urlUtils.validate(url))
    return true;
  else
    throw new ReportedError({
      message: 'Thing URL %s is not a valid URL.',
      messageParams: [url],
      userMessage: 'invalid url',
      userMessageParams: []
    });
}

module.exports = Thing;
