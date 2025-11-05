import { randomUUID } from 'crypto';
import { decodeHTML } from 'entities';
import isUUID from 'is-uuid';
import adapters from '../adapters/adapters.ts';
import dal from '../dal/index.ts';
import { createModelModule } from '../dal/lib/model-handle.ts';
import { initializeModel } from '../dal/lib/model-initializer.ts';
import type { JsonObject, ModelConstructor, ModelInstance } from '../dal/lib/model-types.ts';
import languages from '../locales/languages.ts';
import search from '../search.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import urlUtils from '../util/url-utils.ts';
import File from './file.ts';
import Review from './review.ts';
import ThingSlug from './thing-slug.ts';
import User from './user.ts';

type PostgresModule = typeof import('../db-postgres.ts');

type ThingRecord = JsonObject;
type ThingVirtual = JsonObject;
type ThingInstance = ModelInstance<ThingRecord, ThingVirtual> & Record<string, any>;
type ThingModel = ModelConstructor<ThingRecord, ThingVirtual, ThingInstance> & Record<string, any>;

let postgresModulePromise: Promise<PostgresModule> | null = null;
async function loadDbPostgres(): Promise<PostgresModule> {
  if (!postgresModulePromise) postgresModulePromise = import('../db-postgres.ts');
  return postgresModulePromise;
}

async function getPostgresDAL(): Promise<Record<string, any>> {
  const module = await loadDbPostgres();
  return module.getPostgresDAL();
}

const { proxy: thingHandleProxy, register: registerThingHandle } = createModelModule<
  ThingRecord,
  ThingVirtual,
  ThingInstance
>({
  tableName: 'things',
});

const ThingHandle = thingHandleProxy as ThingModel;

const { types, mlString } = dal as unknown as {
  types: Record<string, any>;
  mlString: Record<string, any>;
};
const { isValid: isValidLanguage } = languages as unknown as { isValid: (code: string) => boolean };
/**
 * Resolve the Review model at call time to avoid circular import initialization.
 */
function getReviewModel(): Record<string, any> {
  return Review as unknown as Record<string, any>;
}

/**
 * Resolve the File model lazily for compatibility with Node.js ESM cycles.
 */
function getFileModel(): Record<string, any> {
  return File as unknown as Record<string, any>;
}

/**
 * Resolve the User model lazily for compatibility with Node.js ESM cycles.
 */
function getUserModel(): Record<string, any> {
  return User as unknown as Record<string, any>;
}

let Thing: ThingModel | null = null;

/**
 * Initialize the PostgreSQL Thing model.
 *
 * @param dalInstance - Optional DAL instance for testing
 */
async function initializeThingModel(
  dalInstance: Record<string, any> | null = null
): Promise<ThingModel | null> {
  const activeDAL = dalInstance ?? (await getPostgresDAL());

  if (!activeDAL) {
    debug.db('PostgreSQL DAL not available, skipping Thing model initialization');
    return null;
  }

  try {
    // Create the schema with revision fields
    const thingSchema = {
      id: types.string().uuid(4),

      // Array of URLs (first is primary)
      urls: types.array(types.string().validator(_isValidURL)),

      // JSONB multilingual fields
      label: mlString.getSchema({ maxLength: 256 }),
      aliases: mlString.getSchema({ maxLength: 256, array: true }),

      // Grouped metadata in JSONB for extensibility
      metadata: types.object().validator(_validateMetadata),

      // Complex sync data in JSONB
      sync: types.object(),

      // CamelCase relational fields that map to snake_case database columns
      originalLanguage: types.string().max(4).validator(isValidLanguage),
      canonicalSlugName: types.string(),
      createdOn: types.date().required(true),
      createdBy: types.string().uuid(4).required(true),

      // Virtual fields for compatibility
      urlID: types.virtual().default(function (this: ThingInstance) {
        const slugName =
          typeof this.getValue === 'function'
            ? this.getValue('canonicalSlugName')
            : this.canonicalSlugName;
        return slugName ? encodeURIComponent(String(slugName)) : this.id;
      }),

      // Permission virtual fields
      userCanDelete: types.virtual().default(false),
      userCanEdit: types.virtual().default(false),
      userCanUpload: types.virtual().default(false),
      userIsCreator: types.virtual().default(false),

      // Metrics virtual fields (populated asynchronously)
      numberOfReviews: types.virtual().default(0),
      averageStarRating: types.virtual().default(0),

      // Virtual accessors for nested metadata JSONB fields
      description: types.virtual().default(function (this: ThingInstance) {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.description;
      }),
      subtitle: types.virtual().default(function (this: ThingInstance) {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.subtitle;
      }),
      authors: types.virtual().default(function (this: ThingInstance) {
        const metadata =
          typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
        return metadata?.authors;
      }),
    };

    const { model } = initializeModel<ThingRecord, ThingVirtual, ThingInstance>({
      dal: activeDAL as any,
      baseTable: 'things',
      schema: thingSchema,
      camelToSnake: {
        originalLanguage: 'original_language',
        canonicalSlugName: 'canonical_slug_name',
        createdOn: 'created_on',
        createdBy: 'created_by',
      },
      withRevision: {
        static: [
          'createFirstRevision',
          'getNotStaleOrDeleted',
          'filterNotStaleOrDeleted',
          'getMultipleNotStaleOrDeleted',
        ],
        instance: ['deleteAllRevisions'],
      },
      staticMethods: {
        lookupByURL,
        getWithData,
        getLabel,
      },
      instanceMethods: {
        initializeFieldsFromAdapter,
        populateUserInfo,
        populateReviewMetrics,
        setURLs,
        updateActiveSyncs,
        getSourceIDsOfActiveSyncs,
        updateSlug,
        getReviewsByUser,
        getAverageStarRating,
        getReviewCount,
        addFile,
        addFilesByIDsAndSave,
      },
      relations: [
        {
          name: 'reviews',
          targetTable: 'reviews',
          sourceKey: 'id',
          targetKey: 'thing_id',
          hasRevisions: true,
          cardinality: 'many',
        },
        {
          name: 'files',
          targetTable: 'files',
          sourceKey: 'id',
          targetKey: 'id',
          hasRevisions: true,
          through: {
            table: 'thing_files',
            sourceForeignKey: 'thing_id',
            targetForeignKey: 'file_id',
          },
          cardinality: 'many',
        },
      ] as any,
    });
    Thing = model as ThingModel;

    debug.db('PostgreSQL Thing model initialized with all methods');
    return Thing;
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Failed to initialize PostgreSQL Thing model:');
    debug.error({ error: serializedError });
    return null;
  }
}

// NOTE: STATIC METHODS --------------------------------------------------------

/**
 * Find a Thing object using a URL. May return multiple matches (but ordinarily
 * should not).
 *
 * @param url - the URL to look up
 * @param userID - include any review(s) of this thing by the given user
 * @returns array of matching things
 */
async function lookupByURL(url: string, userID?: string | null): Promise<ThingInstance[]> {
  const model = (Thing ?? ThingHandle) as ThingModel;
  const tableName = model.tableName ?? 'things';

  const query = `
    SELECT * FROM ${tableName}
    WHERE urls @> ARRAY[$1]
      AND (_old_rev_of IS NULL)
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
  `;

  const dalInstance = model.dal as
    | { query: (text: string, params?: unknown[]) => Promise<{ rows: JsonObject[] }> }
    | undefined;
  if (!dalInstance) {
    throw new Error('Thing DAL not initialized');
  }

  const result = await dalInstance.query(query, [url]);
  const things = result.rows.map(row => model._createInstance(row)) as ThingInstance[];

  if (typeof userID === 'string') {
    const lookupUserID = typeof userID.trim === 'function' ? userID.trim() : userID;
    const thingIDs = things
      .map(thing => thing.id)
      .filter(id => typeof id === 'string' && id.length > 0);

    // Default to empty arrays so API consumers can rely on the property
    things.forEach(thing => {
      thing.reviews = [];
    });

    if (thingIDs.length > 0) {
      try {
        const reviews = await getReviewModel()
          .filterNotStaleOrDeleted()
          .whereIn('thing_id', thingIDs, { cast: 'uuid[]' })
          .filter({ createdBy: lookupUserID })
          .orderBy('created_on', 'DESC')
          .limit(50)
          .run();

        const reviewsByThing = new Map<string, any[]>();
        for (const review of reviews) {
          if (typeof review.populateUserInfo === 'function') {
            review.populateUserInfo({ id: lookupUserID });
          }

          const reviewThingID = review.thingID;
          if (!reviewThingID) {
            continue;
          }

          if (!reviewsByThing.has(reviewThingID)) {
            reviewsByThing.set(reviewThingID, []);
          }

          reviewsByThing.get(reviewThingID)?.push(review);
        }

        things.forEach(thing => {
          const userReviews = reviewsByThing.get(thing.id);
          if (Array.isArray(userReviews)) {
            thing.reviews = userReviews;
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debug.db('Failed to include user reviews in Thing.lookupByURL:', message);
      }
    }
  }

  return things;
}

/**
 * Get a Thing object by ID, plus some of the data linked to it.
 *
 * @param id - the unique ID of the Thing object
 * @param options - controls which data to include
 * @returns the Thing object
 */
async function getWithData(
  id: string,
  {
    withFiles = true,
    withReviewMetrics = true,
  }: { withFiles?: boolean; withReviewMetrics?: boolean } = {}
): Promise<ThingInstance> {
  const model = (Thing ?? ThingHandle) as ThingModel;

  const joinOptions: Record<string, any> = {};
  if (withFiles) {
    joinOptions.files = {
      _apply: seq => seq.filter({ completed: true }),
    };
  }

  const thing = Object.keys(joinOptions).length
    ? await model.getNotStaleOrDeleted(id, joinOptions)
    : await model.getNotStaleOrDeleted(id);

  if (withFiles) {
    thing.files = Array.isArray(thing.files) ? thing.files : [];
    await _attachUploadersToFiles(thing.files);
  }

  if (withReviewMetrics) {
    await thing.populateReviewMetrics();
  }

  return thing as ThingInstance;
}

/**
 * Get label for a given thing in the provided language, or fall back to a
 * prettified URL.
 *
 * @param thing - the thing object to get a label for
 * @param language - the language code of the preferred language
 * @returns the best available label
 */
function getLabel(
  thing: ThingInstance | JsonObject | null | undefined,
  language: string
): string | undefined {
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
 * @param adapterResult - the result from any backend adapter
 * @param adapterResult.data - data for this result
 * @param adapterResult.sourceID - canonical source identifier
 */
function initializeFieldsFromAdapter(
  this: ThingInstance,
  adapterResult: Record<string, any>
): void {
  if (typeof adapterResult !== 'object' || !adapterResult) {
    return;
  }

  const responsibleAdapter = adapters.getAdapterForSource(adapterResult.sourceID) as Record<
    string,
    any
  >;
  const supportedFields = Array.isArray(responsibleAdapter?.getSupportedFields?.())
    ? responsibleAdapter.getSupportedFields()
    : [];

  const data = adapterResult.data as Record<string, any>;
  for (const field in data) {
    if (supportedFields.includes(field)) {
      // Handle metadata grouping for PostgreSQL
      if (['description', 'subtitle', 'authors'].includes(field)) {
        if (!this.metadata) {
          this.metadata = {};
        }
        (this.metadata as Record<string, any>)[field] = data[field];
      } else {
        (this as Record<string, any>)[field] = data[field];
      }

      if (typeof this.sync !== 'object') {
        this.sync = {};
      }
      (this.sync as Record<string, any>)[field] = {
        active: true,
        source: adapterResult.sourceID,
        updated: new Date(),
      };
    }
  }
}

/**
 * Populate virtual permission fields in a Thing object with the rights of a
 * given user.
 *
 * @param user - the user whose permissions to check
 */
function populateUserInfo(this: ThingInstance, user: Record<string, any> | null | undefined): void {
  if (!user) {
    return; // Permissions will be at their default value (false)
  }

  this.userCanDelete = user.isSuperUser || user.isSiteModerator || false;
  this.userCanEdit = user.isSuperUser || user.isTrusted || user.id === this.createdBy;
  this.userCanUpload = user.isSuperUser || user.isTrusted;
  this.userIsCreator = user.id === this.createdBy;
}

/**
 * Set this Thing object's virtual data fields for review metrics.
 *
 * @returns the modified thing object
 */
async function populateReviewMetrics(this: ThingInstance): Promise<ThingInstance> {
  const [averageStarRating, numberOfReviews] = await Promise.all([
    this.getAverageStarRating(),
    this.getReviewCount(),
  ]);
  this.averageStarRating = averageStarRating;
  this.numberOfReviews = numberOfReviews;
  return this;
}

/**
 * Update URLs and reset synchronization settings.
 *
 * @param urls - the complete array of URLs to assign
 */
function setURLs(this: ThingInstance, urls: string[]): void {
  // Turn off all synchronization
  if (typeof this.sync === 'object' && this.sync) {
    for (const field in this.sync as Record<string, any>) {
      const syncValue = (this.sync as Record<string, any>)[field];
      if (syncValue) {
        syncValue.active = false;
      }
    }
  }

  // Turn on synchronization for supported fields
  urls.forEach(url => {
    adapters.getAll().forEach(adapter => {
      if (adapter.ask(url)) {
        adapter.getSupportedFields().forEach(field => {
          // Another adapter is already handling this field
          if (
            this.sync &&
            (this.sync as Record<string, any>)[field] &&
            (this.sync as Record<string, any>)[field].active
          ) {
            return;
          }
          if (!this.sync) {
            this.sync = {};
          }

          (this.sync as Record<string, any>)[field] = {
            active: true,
            source: adapter.getSourceID(),
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
 * @param userID - the user to associate with any slug changes
 * @returns the updated thing
 */
async function updateActiveSyncs(this: ThingInstance, userID: string): Promise<ThingInstance> {
  const thing = this as ThingInstance & Record<string, any>;

  if (!thing.urls || !thing.urls.length) {
    return thing;
  }

  if (typeof thing.sync !== 'object') {
    thing.sync = {};
  }

  // Determine which external sources we need to contact
  const sources: string[] = [];
  for (const field in thing.sync as Record<string, any>) {
    const syncEntry = (thing.sync as Record<string, any>)[field];
    if (syncEntry?.active && syncEntry.source && !sources.includes(syncEntry.source)) {
      sources.push(syncEntry.source);
    }
  }

  // Build array of lookup promises from currently used sources
  const promises: Promise<Record<string, any> | undefined>[] = [];
  const allURLs: string[] = [];

  sources.forEach(source => {
    const adapter = adapters.getAdapterForSource(source) as Record<string, any>;
    const relevantURLs = thing.urls.filter(url => adapter.ask(url));
    allURLs.push(...relevantURLs);

    promises.push(
      ...relevantURLs.map(url =>
        adapter.lookup(url).catch(error => {
          const serializedError = error instanceof Error ? error : new Error(String(error));
          debug.error(`Problem contacting adapter "${adapter.getSourceID()}" for URL ${url}.`);
          debug.error({ error: serializedError });
          return undefined;
        })
      )
    );
  });

  if (allURLs.length) {
    debug.app(
      `Retrieving item metadata for ${thing.id} from the following URL(s):\n` + allURLs.join(', ')
    );
  }

  const results = await Promise.all(promises);
  let needSlugUpdate = false;

  // Organize data by source and update fields
  const dataBySource = _organizeDataBySource(results);

  sources.forEach(source => {
    for (const field in thing.sync as Record<string, any>) {
      const syncEntry = (thing.sync as Record<string, any>)[field];
      if (syncEntry?.active && syncEntry.source === source && Array.isArray(dataBySource[source])) {
        for (const data of dataBySource[source]) {
          if (data[field] !== undefined) {
            // Create a new sync object to ensure change detection works
            const newSync = { ...(thing.sync as Record<string, any>) };
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
    try {
      await thing.updateSlug(userID, thing.originalLanguage || 'en');
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error('Failed to update slug after sync:');
      debug.error({ error: serializedError });
    }
  }

  await thing.save();

  // Index update can keep running after we resolve this promise
  (search as Record<string, any>).indexThing?.(thing);

  return thing;

  /**
   * Organize valid data from results array into an object with sourceID as key
   *
   * @param results - results from multiple adapters
   * @returns key = source, value = array of data objects
   */
  function _organizeDataBySource(
    results: Array<Record<string, any> | undefined>
  ): Record<string, any[]> {
    const rv: Record<string, any[]> = {};
    results.forEach(result => {
      if (
        result &&
        typeof result === 'object' &&
        typeof result.sourceID === 'string' &&
        typeof result.data === 'object'
      ) {
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
 * @returns array of the source IDs
 */
function getSourceIDsOfActiveSyncs(this: ThingInstance): string[] {
  const sync = this.sync as Record<string, any> | undefined;
  const rv: string[] = [];
  if (!sync) {
    return rv;
  }
  for (const key in sync) {
    const entry = sync[key];
    if (entry && entry.active && entry.source && !rv.includes(entry.source)) {
      rv.push(entry.source);
    }
  }
  return rv;
}

/**
 * Fetch up to 50 reviews authored by the given user for this thing.
 *
 * Uses the PostgreSQL review feed to reuse join logic and populates
 * permission flags on each returned review.
 *
 * @param user - Current user performing the lookup
 * @returns Reviews authored by the user (empty array if none)
 */
async function getReviewsByUser(
  this: ThingInstance,
  user: Record<string, any> | null | undefined
): Promise<any[]> {
  if (!user || !user.id) {
    return [];
  }

  try {
    const feed = await getReviewModel().getFeed({
      thingID: this.id,
      createdBy: user.id,
      withThing: false,
      withTeams: true,
      limit: 50,
    });

    const reviews = Array.isArray(feed.feedItems) ? feed.feedItems : [];

    reviews.forEach(review => {
      if (typeof review.populateUserInfo === 'function') {
        review.populateUserInfo(user);
      }
    });

    return reviews;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debug.db('Failed to fetch user reviews in Thing.getReviewsByUser:', message);
    return [];
  }
}

/**
 * Calculate the average review rating for this Thing object.
 *
 * @returns average rating, not rounded
 */
async function getAverageStarRating(this: ThingInstance): Promise<number> {
  try {
    const model = (Thing ?? ThingHandle) as ThingModel;
    const dalInstance = model.dal as Record<string, any> | undefined;
    if (!dalInstance?.query) {
      return 0;
    }
    const reviewTableName = dalInstance.schemaNamespace
      ? `${dalInstance.schemaNamespace}reviews`
      : 'reviews';
    const query = `
      SELECT AVG(star_rating) as avg_rating
      FROM ${reviewTableName}
      WHERE thing_id = $1
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;

    const result = await dalInstance.query(query, [this.id]);
    return parseFloat(result.rows[0]?.avg_rating || 0);
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Error calculating average star rating:');
    debug.error({ error: serializedError });
    return 0;
  }
}

/**
 * Count the number of reviews associated with this Thing object.
 *
 * @returns the number of reviews
 */
async function getReviewCount(this: ThingInstance): Promise<number> {
  try {
    const model = (Thing ?? ThingHandle) as ThingModel;
    const dalInstance = model.dal as Record<string, any> | undefined;
    if (!dalInstance?.query) {
      return 0;
    }
    const reviewTableName = dalInstance.schemaNamespace
      ? `${dalInstance.schemaNamespace}reviews`
      : 'reviews';
    const query = `
      SELECT COUNT(*) as review_count
      FROM ${reviewTableName}
      WHERE thing_id = $1
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;

    const result = await dalInstance.query(query, [this.id]);
    return parseInt(result.rows[0]?.review_count || 0, 10);
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Error counting reviews:');
    debug.error({ error: serializedError });
    return 0;
  }
}

/**
 * Simple helper method to initialize files array for a Thing object.
 *
 * @param file - File object to add
 */
function addFile(this: ThingInstance, file: Record<string, any>): void {
  if (this.files === undefined) {
    this.files = [];
  }
  this.files.push(file);
}

/**
 * Create or update the canonical slug for this Thing.
 *
 * @param userID - User ID responsible for the slug change
 * @param language - Preferred language for slug generation
 * @returns the updated Thing instance
 */
async function updateSlug(
  this: ThingInstance,
  userID: string,
  language?: string
): Promise<ThingInstance> {
  const originalLanguage = this.originalLanguage || 'en';
  const slugLanguage = language || originalLanguage;

  if (slugLanguage !== originalLanguage) {
    return this;
  }

  if (!this.label) {
    return this;
  }

  const resolved = mlString.resolve(slugLanguage, this.label) as { str?: string } | null;
  if (!resolved || typeof resolved.str !== 'string' || !resolved.str.trim()) {
    return this;
  }

  let baseSlug;
  try {
    baseSlug = _generateSlugName(resolved.str);
  } catch {
    return this;
  }

  if (!baseSlug || baseSlug === this.canonicalSlugName) {
    return this;
  }

  if (!this.id) {
    this.id = randomUUID();
  }

  const slug = new ThingSlug({});
  slug.slug = baseSlug;
  slug.name = baseSlug;
  slug.baseName = baseSlug;
  slug.thingID = this.id;
  slug.createdOn = new Date();
  slug.createdBy = userID;

  try {
    const savedSlug = await (slug as Record<string, any>).qualifiedSave();
    if (savedSlug && savedSlug.name) {
      this.canonicalSlugName = savedSlug.name;
      const model = (Thing ?? ThingHandle) as ThingModel;
      const changedSet = this._changed as Set<string> | undefined;
      const dbFieldName = model._getDbFieldName
        ? model._getDbFieldName('canonicalSlugName')
        : 'canonical_slug_name';
      changedSet?.add(dbFieldName);
    }
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Failed to update Thing slug:');
    debug.error({ error: serializedError });
  }

  return this;
}

/**
 * Obtain file objects for an array of file IDs, and associate them with this thing.
 *
 * @param fileIDs - IDs of the files to add
 * @param userID - if given, uploader must match this user ID
 */
async function addFilesByIDsAndSave(
  this: ThingInstance,
  fileIDs: string[],
  userID?: string
): Promise<ThingInstance> {
  const thingModel = (Thing ?? ThingHandle) as ThingModel;

  if (!Array.isArray(fileIDs) || fileIDs.length === 0) {
    return this;
  }

  const uniqueIDs = [...new Set(fileIDs.filter(id => typeof id === 'string' && id.length))];
  if (uniqueIDs.length === 0) {
    return this;
  }

  try {
    const placeholders = uniqueIDs.map((_, index) => `$${index + 1}`).join(', ');
    const query = `
      SELECT *
      FROM ${File.tableName}
      WHERE id IN (${placeholders})
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;

    const fileModel = getFileModel();
    const fileDal = fileModel.dal as Record<string, any>;
    const result = await fileDal.query(query, uniqueIDs);
    const validFiles = result.rows
      .map(row => fileModel._createInstance(row))
      .filter(file => !userID || file.uploadedBy === userID);

    if (!validFiles.length) {
      return this;
    }

    const dalInstance = thingModel.dal as Record<string, any>;
    const junctionTable = dalInstance.schemaNamespace
      ? `${dalInstance.schemaNamespace}thing_files`
      : 'thing_files';
    const insertValues = [];
    const valueClauses = [];
    let paramIndex = 1;

    validFiles.forEach(file => {
      valueClauses.push(`($${paramIndex}, $${paramIndex + 1})`);
      insertValues.push(this.id, file.id);
      paramIndex += 2;
    });

    if (valueClauses.length) {
      const insertQuery = `
        INSERT INTO ${junctionTable} (thing_id, file_id)
        VALUES ${valueClauses.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      await dalInstance.query(insertQuery, insertValues);
    }

    const existingIDs = new Set((this.files || []).map(file => file.id));
    validFiles.forEach(file => {
      if (!existingIDs.has(file.id)) {
        this.addFile(file);
        existingIDs.add(file.id);
      }
    });
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error('Failed to associate files with Thing:');
    debug.error({ error: serializedError });
    throw error;
  }

  return this;
}

// Helper functions

async function _attachUploadersToFiles(files: Array<Record<string, any>>): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }

  const uploaderIDs: string[] = [];
  const seen = new Set<string>();
  files.forEach(file => {
    const uploaderID = file && file.uploadedBy;
    if (typeof uploaderID === 'string' && !seen.has(uploaderID)) {
      seen.add(uploaderID);
      uploaderIDs.push(uploaderID);
    }
  });

  if (!uploaderIDs.length) {
    return;
  }

  try {
    // Users don't have revisions, use whereIn for array of IDs
    const userModel = getUserModel();
    const result = await userModel.filter({}).whereIn('id', uploaderIDs, { cast: 'uuid[]' }).run();

    const uploaderMap = new Map<string, any>();
    for (const uploader of result || []) {
      if (!uploader || !uploader.id) {
        continue;
      }
      uploaderMap.set(uploader.id, uploader);
    }

    files.forEach(file => {
      if (!file || !file.uploadedBy) {
        return;
      }
      const uploader = uploaderMap.get(file.uploadedBy);
      if (uploader) {
        file.uploader = uploader;
      }
    });
  } catch (error) {
    const serializedError = error instanceof Error ? error : new Error(String(error));
    debug.error(`Failed to attach uploader data to files: ${serializedError.message}`);
    if (serializedError.stack) {
      debug.error(serializedError.stack);
    }
  }
}

/**
 * Validate URL format.
 *
 * @param url - URL to check
 * @returns true if valid
 * @throws ReportedError if invalid
 */
function _isValidURL(url: string): boolean {
  if (urlUtils.validate(url)) {
    return true;
  } else {
    throw new ReportedError({
      message: 'Thing URL %s is not a valid URL.',
      messageParams: [url],
      userMessage: 'invalid url',
      userMessageParams: [],
    });
  }
}

function _generateSlugName(str: string): string {
  let slug = decodeHTML(str)
    .trim()
    .toLowerCase()
    .replace(/[?&"″'`’<>:]/g, '')
    .replace(/[ _/]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  slug = slug
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) {
    throw new Error('Source string cannot be converted to a valid slug.');
  }

  if (isUUID.v4(slug)) {
    throw new Error('Source string cannot be a UUID.');
  }

  return slug;
}

/**
 * Validate metadata JSONB structure.
 *
 * @param metadata - Metadata object to validate
 * @returns true if valid
 */
function _validateMetadata(metadata: unknown): boolean {
  if (metadata === null || metadata === undefined) {
    return true;
  }

  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Metadata must be an object');
  }

  // Validate known metadata fields
  const validFields = ['description', 'subtitle', 'authors'];
  const entries = Object.entries(metadata as Record<string, any>);
  for (const [key, value] of entries) {
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

registerThingHandle({
  initializeModel: initializeThingModel,
  additionalExports: {
    initializeThingModel,
  },
});

export default ThingHandle;
export { initializeThingModel as initializeModel, initializeThingModel };
