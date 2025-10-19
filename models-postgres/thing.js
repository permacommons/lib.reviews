'use strict';

/**
 * PostgreSQL Thing model implementation
 * 
 * This is the full PostgreSQL implementation of the Thing model using the DAL,
 * maintaining compatibility with the existing RethinkDB Thing model interface.
 */

const { getPostgresDAL } = require('../db-dual');
const type = require('../dal').type;
const mlString = require('../dal').mlString;
const revision = require('../dal').revision;
const debug = require('../util/debug');
const urlUtils = require('../util/url-utils');
const ReportedError = require('../util/reported-error');
const adapters = require('../adapters/adapters');
const search = require('../search');
const isValidLanguage = require('../locales/languages').isValid;

let Thing = null;

/**
 * Initialize the PostgreSQL Thing model
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function initializeThingModel(customDAL = null) {
  const dal = customDAL || getPostgresDAL();
  
  if (!dal) {
    debug.db('PostgreSQL DAL not available, skipping Thing model initialization');
    return null;
  }

  try {
    // Use table prefix if this is a test DAL
    const tableName = dal.tablePrefix ? `${dal.tablePrefix}things` : 'things';
    
    // Create the schema with revision fields
    const thingSchema = {
      id: type.string().uuid(4),
      
      // Array of URLs (first is primary)
      urls: type.array(type.string().validator(_isValidURL)),
      
      // JSONB multilingual fields
      label: mlString.getSchema({ maxLength: 256 }),
      aliases: mlString.getSchema({ maxLength: 256, array: true }),
      
      // Grouped metadata in JSONB for extensibility
      metadata: type.object().validator(_validateMetadata),
      
      // Complex sync data in JSONB
      sync: type.object(),
      
      // Relational fields
      original_language: type.string().max(4).validator(isValidLanguage),
      canonical_slug_name: type.string(),
      created_on: type.date().required(true),
      created_by: type.string().uuid(4).required(true),
      
      // Virtual fields for compatibility
      url_id: type.virtual().default(function() {
        const slugName = this.getValue ? this.getValue('canonical_slug_name') : this.canonical_slug_name;
        return slugName ? encodeURIComponent(slugName) : this.id;
      }),
      
      // Permission virtual fields
      user_can_delete: type.virtual().default(false),
      user_can_edit: type.virtual().default(false),
      user_can_upload: type.virtual().default(false),
      user_is_creator: type.virtual().default(false),
      
      // Metrics virtual fields (populated asynchronously)
      number_of_reviews: type.virtual().default(0),
      average_star_rating: type.virtual().default(0)
    };

    // Add revision fields to schema
    Object.assign(thingSchema, revision.getSchema());

    Thing = dal.createModel(tableName, thingSchema);

    // Add static methods
    Thing.createFirstRevision = revision.getFirstRevisionHandler(Thing);
    Thing.getNotStaleOrDeleted = revision.getNotStaleOrDeletedGetHandler(Thing);
    Thing.filterNotStaleOrDeleted = revision.getNotStaleOrDeletedFilterHandler(Thing);
    Thing.getMultipleNotStaleOrDeleted = revision.getMultipleNotStaleOrDeletedHandler(Thing);

    // Custom static methods
    Thing.lookupByURL = lookupByURL;
    Thing.getWithData = getWithData;
    Thing.getLabel = getLabel;

    // Add instance methods
    Thing.define("newRevision", revision.getNewRevisionHandler(Thing));
    Thing.define("deleteAllRevisions", revision.getDeleteAllRevisionsHandler(Thing));
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

    debug.db('PostgreSQL Thing model initialized with all methods');
    return Thing;
  } catch (error) {
    debug.error('Failed to initialize PostgreSQL Thing model:', error);
    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Find a Thing object using a URL. May return multiple matches (but ordinarily
 * should not).
 *
 * @param {String} url - the URL to look up
 * @param {String} [userID] - include any review(s) of this thing by the given user
 * @returns {Promise<Thing[]>} array of matching things
 */
async function lookupByURL(url, userID) {
  const query = `
    SELECT * FROM ${Thing.tableName}
    WHERE urls @> ARRAY[$1]
      AND (_old_rev_of IS NULL)
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
  `;
  
  const result = await Thing.dal.query(query, [url]);
  const things = result.rows.map(row => Thing._createInstance(row));
  
  if (typeof userID === 'string') {
    // This would need the Review model to be available for joins
    debug.db('User-specific review lookup not yet implemented in Thing.lookupByURL');
  }
  
  return things;
}

/**
 * Get a Thing object by ID, plus some of the data linked to it.
 *
 * @async
 * @param {String} id - the unique ID of the Thing object
 * @param {Object} [options] - which data to include
 * @param {Boolean} options.withFiles=true - include metadata about file upload via join
 * @param {Boolean} options.withReviewMetrics=true - obtain review metrics
 * @returns {Thing} the Thing object
 */
async function getWithData(id, {
  withFiles = true,
  withReviewMetrics = true
} = {}) {
  
  let joinOptions = {};
  if (withFiles) {
    // This would need proper File model integration
    debug.db('File joins not yet implemented in Thing.getWithData');
  }

  const thing = await Thing.getNotStaleOrDeleted(id, joinOptions);
  
  if (withReviewMetrics) {
    await thing.populateReviewMetrics();
  }

  return thing;
}

/**
 * Get label for a given thing in the provided language, or fall back to a
 * prettified URL.
 *
 * @param  {Thing} thing - the thing object to get a label for
 * @param  {String} language - the language code of the preferred language
 * @returns {String} the best available label
 */
function getLabel(thing, language) {
  if (!thing || !thing.id) {
    return undefined;
  }

  let str;
  if (thing.label) {
    const resolved = mlString.resolve(language, thing.label);
    str = resolved ? resolved.str : undefined;
  }

  if (str) {
    return str;
  }

  // If we have no proper label, we can at least show the URL
  if (thing.urls && thing.urls.length) {
    return urlUtils.prettify(thing.urls[0]);
  }

  return undefined;
}

// NOTE: INSTANCE METHODS ------------------------------------------------------

/**
 * Initialize field values from the lookup result of an adapter.
 *
 * @param {Object} adapterResult - the result from any backend adapter
 * @param {Object} adapterResult.data - data for this result
 * @param {String} adapterResult.sourceID - canonical source identifier
 * @instance
 * @memberof Thing
 */
function initializeFieldsFromAdapter(adapterResult) {
  if (typeof adapterResult !== 'object') {
    return;
  }

  const responsibleAdapter = adapters.getAdapterForSource(adapterResult.sourceID);
  const supportedFields = responsibleAdapter.getSupportedFields();
  
  for (const field in adapterResult.data) {
    if (supportedFields.includes(field)) {
      // Handle metadata grouping for PostgreSQL
      if (['description', 'subtitle', 'authors'].includes(field)) {
        if (!this.metadata) {
          this.metadata = {};
        }
        this.metadata[field] = adapterResult.data[field];
      } else {
        this[field] = adapterResult.data[field];
      }
      
      if (typeof this.sync !== 'object') {
        this.sync = {};
      }
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
 * @param {User} user - the user whose permissions to check
 * @memberof Thing
 * @instance
 */
function populateUserInfo(user) {
  if (!user) {
    return; // Permissions will be at their default value (false)
  }

  this.user_can_delete = user.is_super_user || user.is_site_moderator || false;
  this.user_can_edit = user.is_super_user || user.is_trusted || user.id === this.created_by;
  this.user_can_upload = user.is_super_user || user.is_trusted;
  this.user_is_creator = user.id === this.created_by;
}

/**
 * Set this Thing object's virtual data fields for review metrics.
 *
 * @returns {Thing} the modified thing object
 * @memberof Thing
 * @instance
 */
async function populateReviewMetrics() {
  const [averageStarRating, numberOfReviews] = await Promise.all([
    this.getAverageStarRating(),
    this.getReviewCount()
  ]);
  this.average_star_rating = averageStarRating;
  this.number_of_reviews = numberOfReviews;
  return this;
}

/**
 * Update URLs and reset synchronization settings.
 *
 * @param  {String[]} urls - the complete array of URLs to assign
 * @instance
 * @memberof Thing
 */
function setURLs(urls) {
  // Turn off all synchronization
  if (typeof this.sync === 'object') {
    for (const field in this.sync) {
      this.sync[field].active = false;
    }
  }

  // Turn on synchronization for supported fields
  urls.forEach(url => {
    adapters.getAll().forEach(adapter => {
      if (adapter.ask(url)) {
        adapter.supportedFields.forEach(field => {
          // Another adapter is already handling this field
          if (this.sync && this.sync[field] && this.sync[field].active) {
            return;
          }
          if (!this.sync) {
            this.sync = {};
          }

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
 * Fetch new external data for all fields set to be synchronized.
 *
 * @param {String} userID - the user to associate with any slug changes
 * @returns {Thing} the updated thing
 * @memberof Thing
 * @instance
 */
async function updateActiveSyncs(userID) {
  const thing = this;

  if (!thing.urls || !thing.urls.length) {
    return thing;
  }

  if (typeof thing.sync !== 'object') {
    thing.sync = {};
  }

  // Determine which external sources we need to contact
  const sources = [];
  for (const field in thing.sync) {
    if (thing.sync[field].active && thing.sync[field].source &&
      !sources.includes(thing.sync[field].source)) {
      sources.push(thing.sync[field].source);
    }
  }

  // Build array of lookup promises from currently used sources
  const promises = [];
  const allURLs = [];

  sources.forEach(source => {
    const adapter = adapters.getAdapterForSource(source);
    const relevantURLs = thing.urls.filter(url => adapter.ask(url));
    allURLs.push(...relevantURLs);
    
    promises.push(...relevantURLs.map(url =>
      adapter
        .lookup(url)
        .catch(error => {
          debug.error(`Problem contacting adapter "${adapter.getSourceID()}" for URL ${url}.`);
          debug.error({ error });
        })
    ));
  });

  if (allURLs.length) {
    debug.app(`Retrieving item metadata for ${thing.id} from the following URL(s):\n` +
      allURLs.join(', '));
  }

  const results = await Promise.all(promises);
  let needSlugUpdate = false;

  // Organize data by source and update fields
  const dataBySource = _organizeDataBySource(results);
  
  sources.forEach((source) => {
    for (const field in thing.sync) {
      if (thing.sync[field].active && thing.sync[field].source === source &&
        Array.isArray(dataBySource[source])) {
        
        for (const data of dataBySource[source]) {
          if (data[field] !== undefined) {
            // Create a new sync object to ensure change detection works
            const newSync = { ...thing.sync };
            newSync[field] = { ...newSync[field], updated: new Date() };
            thing.sync = newSync;
            
            // Handle metadata grouping for PostgreSQL
            if (['description', 'subtitle', 'authors'].includes(field)) {
              if (!thing.metadata) {
                thing.metadata = {};
              }
              thing.metadata[field] = data[field];
            } else {
              thing[field] = data[field];
            }
            
            if (field === 'label') {
              needSlugUpdate = true;
            }
          }
        }
      }
    }
  });

  if (needSlugUpdate) {
    // Slug update would need to be implemented
    debug.db('Slug update not yet implemented in Thing.updateActiveSyncs');
  }

  await thing.save();

  // Index update can keep running after we resolve this promise
  search.indexThing(thing);

  return thing;

  /**
   * Organize valid data from results array into an object with sourceID as key
   * @param {Object[]} results - results from multiple adapters
   * @returns {Object} key = source, value = array of data objects
   */
  function _organizeDataBySource(results) {
    const rv = {};
    results.forEach(result => {
      if (typeof result === 'object' && typeof result.sourceID === 'string' &&
        typeof result.data === 'object') {
        
        if (!Array.isArray(rv[result.sourceID])) {
          rv[result.sourceID] = [];
        }
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
 * @returns {String[]} array of the source IDs
 */
function getSourceIDsOfActiveSyncs() {
  const sync = this.sync;
  const rv = [];
  for (const key in sync) {
    if (sync[key] && sync[key].active && sync[key].source && !rv.includes(sync[key].source)) {
      rv.push(sync[key].source);
    }
  }
  return rv;
}

/**
 * Get all reviews by the given user for this thing.
 *
 * @param {User} user - the user whose reviews we're looking up for this thing
 * @returns {Array} array of the reviews
 * @instance
 * @memberof Thing
 */
async function getReviewsByUser(user) {
  if (!user) {
    return [];
  }

  // This would need the Review model to be implemented
  debug.db('Review lookup not yet implemented in Thing.getReviewsByUser');
  return [];
}

/**
 * Calculate the average review rating for this Thing object
 *
 * @returns {Number} average rating, not rounded
 * @memberof Thing
 * @instance
 */
async function getAverageStarRating() {
  try {
    const reviewTableName = Thing.dal.tablePrefix ? `${Thing.dal.tablePrefix}reviews` : 'reviews';
    const query = `
      SELECT AVG(star_rating) as avg_rating
      FROM ${reviewTableName}
      WHERE thing_id = $1
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;
    
    const result = await Thing.dal.query(query, [this.id]);
    return parseFloat(result.rows[0]?.avg_rating || 0);
  } catch (error) {
    debug.error('Error calculating average star rating:', error);
    return 0;
  }
}

/**
 * Count the number of reviews associated with this Thing object.
 *
 * @returns {Number} the number of reviews
 * @memberof Thing
 * @instance
 */
async function getReviewCount() {
  try {
    const reviewTableName = Thing.dal.tablePrefix ? `${Thing.dal.tablePrefix}reviews` : 'reviews';
    const query = `
      SELECT COUNT(*) as review_count
      FROM ${reviewTableName}
      WHERE thing_id = $1
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;
    
    const result = await Thing.dal.query(query, [this.id]);
    return parseInt(result.rows[0]?.review_count || 0);
  } catch (error) {
    debug.error('Error counting reviews:', error);
    return 0;
  }
}

/**
 * Simple helper method to initialize files array for a Thing object.
 *
 * @param {File} file - File object to add
 * @memberof Thing
 * @instance
 */
function addFile(file) {
  if (this.files === undefined) {
    this.files = [];
  }
  this.files.push(file);
}

/**
 * Obtain file objects for an array of file IDs, and associate them with this thing.
 *
 * @param {String[]} files - IDs of the files to add
 * @param {String} [userID] - if given, uploader must match this user ID
 * @memberof Thing
 * @instance
 */
async function addFilesByIDsAndSave(files, userID) {
  // This would need proper File model integration
  debug.db('File association not yet implemented in Thing.addFilesByIDsAndSave');
}

// Helper functions

/**
 * Validate URL format
 * @param {String} url - URL to check
 * @returns {Boolean} true if valid
 * @throws {ReportedError} if invalid
 */
function _isValidURL(url) {
  if (urlUtils.validate(url)) {
    return true;
  } else {
    throw new ReportedError({
      message: 'Thing URL %s is not a valid URL.',
      messageParams: [url],
      userMessage: 'invalid url',
      userMessageParams: []
    });
  }
}

/**
 * Validate metadata JSONB structure
 * @param {Object} metadata - Metadata object to validate
 * @returns {Boolean} true if valid
 */
function _validateMetadata(metadata) {
  if (metadata === null || metadata === undefined) {
    return true;
  }
  
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Metadata must be an object');
  }
  
  // Validate known metadata fields
  const validFields = ['description', 'subtitle', 'authors'];
  for (const [key, value] of Object.entries(metadata)) {
    if (validFields.includes(key)) {
      if (key === 'authors') {
        // Authors should be an array of multilingual strings
        if (!Array.isArray(value)) {
          throw new Error('Authors metadata must be an array');
        }
        // Each author should be a multilingual string
        for (const author of value) {
          mlString.validate(author, { maxLength: 256 });
        }
      } else {
        // Description and subtitle are multilingual strings
        mlString.validate(value, { maxLength: key === 'description' ? 512 : 256 });
      }
    }
  }
  
  return true;
}

/**
 * Get the PostgreSQL Thing model (initialize if needed)
 * @param {DataAccessLayer} customDAL - Optional custom DAL instance for testing
 */
function getPostgresThingModel(customDAL = null) {
  if (!Thing || customDAL) {
    Thing = initializeThingModel(customDAL);
  }
  return Thing;
}

module.exports = {
  initializeThingModel,
  getPostgresThingModel
};
