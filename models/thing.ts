import { randomUUID } from 'crypto';
import { decodeHTML } from 'entities';
import isUUID from 'is-uuid';
import type {
  AdapterLookupData,
  AdapterLookupResult,
} from '../adapters/abstract-backend-adapter.ts';
import adapters from '../adapters/adapters.ts';
import type { JoinOptions } from '../dal/index.ts';
import dal from '../dal/index.ts';
import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import type { VersionedModelInstance } from '../dal/lib/model-types.ts';
import search from '../search.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import { generateSlugName } from '../util/slug.ts';
import urlUtils from '../util/url-utils.ts';
import type { FileInstance } from './manifests/file.ts';
import { referenceFile } from './manifests/file.ts';
import { type ReviewInstance, referenceReview } from './manifests/review.ts';
import thingManifest, {
  type MetadataData,
  type SyncData,
  type SyncEntry,
  type SyncField,
  type ThingInstance,
  type ThingInstanceMethods,
  type ThingLabelSource,
  type ThingModel,
  type ThingStaticMethods,
} from './manifests/thing.ts';
import ThingSlug from './thing-slug.ts';
import User, { fetchUserPublicProfiles, type UserAccessContext, type UserView } from './user.ts';

const Review = referenceReview();
const File = referenceFile();

const { mlString } = dal;

const thingStaticMethods = defineStaticMethods(thingManifest, {
  /**
   * Find Thing records associated with a URL, optionally enriching them with
   * reviews authored by the provided user.
   *
   * @param url - URL to look up
   * @param userID - Include reviews authored by this user
   * @returns Matching Thing instances
   */
  async lookupByURL(this: ThingModel, url: string, userID?: string | null) {
    const tableName = this.tableName ?? 'things';

    const query = `
      SELECT * FROM ${tableName}
      WHERE urls @> ARRAY[$1]
        AND (_old_rev_of IS NULL)
        AND (_rev_deleted IS NULL OR _rev_deleted = false)
    `;

    const result = await this.dal.query(query, [url]);
    // Cast required: createFromRow returns base instance type, but runtime
    // attaches instance methods defined in the manifest.
    const things = result.rows.map(row => this.createFromRow(row) as ThingInstance);

    if (typeof userID === 'string') {
      const lookupUserID = typeof userID.trim === 'function' ? userID.trim() : userID;
      const thingIDs = things
        .map(thing => thing.id)
        .filter(id => typeof id === 'string' && id.length > 0);

      things.forEach(thing => {
        thing.reviews = [];
      });

      if (thingIDs.length > 0) {
        try {
          const reviews = await Review.filterWhere({ createdBy: lookupUserID })
            .whereIn('thingID', thingIDs, { cast: 'uuid[]' })
            .orderBy('createdOn', 'DESC')
            .limit(50)
            .run();

          const reviewsByThing = new Map<string, ReviewInstance[]>();
          const viewerForLookup: UserAccessContext = { id: lookupUserID };

          for (const review of reviews) {
            review.populateUserInfo(viewerForLookup);

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
  },
  /**
   * Retrieve a Thing record and optionally hydrate associated files and
   * review metrics.
   *
   * @param id - Thing identifier to fetch
   * @param options - Controls which related data are included
   * @returns The hydrated Thing instance
   */
  async getWithData(
    this: ThingModel,
    id: string,
    {
      withFiles = true,
      withReviewMetrics = true,
    }: { withFiles?: boolean; withReviewMetrics?: boolean } = {}
  ) {
    const joinOptions: JoinOptions = {};
    if (withFiles) {
      joinOptions.files = {
        _apply: qb => qb.filterWhere({ completed: true }),
      };
    }

    const thing = Object.keys(joinOptions).length
      ? await this.getNotStaleOrDeleted(id, joinOptions)
      : await this.getNotStaleOrDeleted(id);

    if (withFiles) {
      thing.files = Array.isArray(thing.files) ? thing.files : [];
      await _attachUploadersToFiles(thing.files);
    }

    if (withReviewMetrics && typeof thing.populateReviewMetrics === 'function') {
      await thing.populateReviewMetrics();
    }

    return thing;
  },
  /**
   * Select the best available label for a Thing in the requested language.
   *
   * @param thing - Thing instance to label
   * @param language - Preferred language code
   * @returns The resolved label or undefined when unavailable
   */
  getLabel(this: ThingModel, thing: ThingLabelSource | null | undefined, language: string) {
    if (!thing || !thing.id) {
      return undefined;
    }

    let str;
    if (thing.label) {
      const resolved = mlString.resolve(language, thing.label as Record<string, string>);
      str = resolved ? resolved.str : undefined;
    }

    if (str) {
      return str;
    }

    if (Array.isArray(thing.urls) && thing.urls.length) {
      return urlUtils.prettify(thing.urls[0]);
    }

    return undefined;
  },
}) satisfies ThingStaticMethods;

const thingInstanceMethods = defineInstanceMethods(thingManifest, {
  /**
   * Initialize Thing fields using the result of an adapter lookup.
   *
   * @param adapterResult - Result object returned from a backend adapter
   */
  initializeFieldsFromAdapter(this: ThingInstance, adapterResult: AdapterLookupResult) {
    if (typeof adapterResult !== 'object' || !adapterResult) {
      return;
    }

    const responsibleAdapter = adapters.getAdapterForSource(adapterResult.sourceID);
    const supportedFields = responsibleAdapter?.getSupportedFields() ?? [];

    const data = adapterResult.data;
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined || !supportedFields.includes(field)) {
        continue;
      }

      if (['description', 'subtitle', 'authors'].includes(field)) {
        if (!this.metadata) {
          this.metadata = {};
        }
        (this.metadata as Record<string, unknown>)[field] = value;
      } else {
        (this as Record<string, unknown>)[field] = value;
      }

      if (typeof this.sync !== 'object') {
        this.sync = {};
      }
      (this.sync as SyncData)[field] = {
        active: true,
        source: adapterResult.sourceID,
        updated: new Date(),
      };
    }
  },
  /**
   * Populate virtual permission flags for the given viewer.
   *
   * @param user - Viewer whose permissions should be reflected on the instance
   */
  populateUserInfo(this: ThingInstance, user: UserAccessContext | null | undefined) {
    if (!user) {
      return;
    }

    const isSuperUser = Boolean(user.isSuperUser);
    const isSiteModerator = Boolean(user.isSiteModerator);
    const isTrusted = Boolean(user.isTrusted);
    const isCreator = user.id === this.createdBy;

    this.userCanDelete = isSuperUser || isSiteModerator;
    this.userCanEdit = isSuperUser || isTrusted || isCreator;
    this.userCanUpload = isSuperUser || isTrusted;
    this.userIsCreator = isCreator;
  },
  /**
   * Resolve review metrics and populate the corresponding virtual fields.
   *
   * @returns The current Thing instance
   */
  async populateReviewMetrics(this: ThingInstance): Promise<ThingInstance> {
    const [averageStarRating, numberOfReviews] = await Promise.all([
      this.getAverageStarRating(),
      this.getReviewCount(),
    ]);
    this.averageStarRating = averageStarRating;
    this.numberOfReviews = numberOfReviews;
    return this;
  },
  /**
   * Update URLs and synchronize adapter tracking state for the Thing.
   *
   * @param urls - Complete set of URLs to assign
   */
  setURLs(this: ThingInstance, urls: string[]) {
    const sync = (this.sync ?? {}) as SyncData;
    if (typeof this.sync === 'object' && this.sync) {
      for (const [, syncValue] of Object.entries(sync) as [SyncField, SyncEntry][]) {
        if (syncValue) {
          syncValue.active = false;
        }
      }
    }

    urls.forEach(url => {
      adapters.getAll().forEach(adapter => {
        if (adapter.ask(url)) {
          // getSupportedFields returns SyncField-compatible strings
          const fields = adapter.getSupportedFields() as SyncField[];
          fields.forEach(field => {
            if (sync[field]?.active) {
              return;
            }

            sync[field] = {
              active: true,
              source: adapter.getSourceID(),
            };
          });
        }
      });
    });
    this.sync = sync;
    this.urls = urls;
  },
  /**
   * Fetch new external data for all active sync sources.
   *
   * @param userID - User responsible for any slug updates
   * @returns The updated Thing instance
   */
  async updateActiveSyncs(this: ThingInstance, userID?: string): Promise<ThingInstance> {
    if (!this.urls || !this.urls.length) {
      return this;
    }

    const sync = (this.sync ?? {}) as SyncData;

    const sources: string[] = [];
    for (const [, syncEntry] of Object.entries(sync) as [SyncField, SyncEntry][]) {
      if (syncEntry?.active && syncEntry.source && !sources.includes(syncEntry.source)) {
        sources.push(syncEntry.source);
      }
    }

    const promises: Promise<AdapterLookupResult | undefined>[] = [];
    const allURLs: string[] = [];

    sources.forEach(source => {
      const adapter = adapters.getAdapterForSource(source);
      if (!adapter) return;

      const relevantURLs = this.urls!.filter(url => adapter.ask(url));
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
        `Retrieving item metadata for ${this.id} from the following URL(s):\n` + allURLs.join(', ')
      );
    }

    const results = await Promise.all(promises);
    let needSlugUpdate = false;

    const dataBySource = _organizeDataBySource(results);

    sources.forEach(source => {
      for (const [field, syncEntry] of Object.entries(sync) as [SyncField, SyncEntry][]) {
        if (
          syncEntry?.active &&
          syncEntry.source === source &&
          Array.isArray(dataBySource[source])
        ) {
          for (const adapterData of dataBySource[source]) {
            const value = adapterData[field];
            if (value !== undefined) {
              sync[field] = { ...syncEntry, updated: new Date() };

              if (['description', 'subtitle', 'authors'].includes(field)) {
                if (!this.metadata) {
                  this.metadata = {};
                }
                (this.metadata as Record<string, unknown>)[field] = value;
              } else {
                // Dynamic field assignment for adapter-synced fields
                (this as Record<string, unknown>)[field] = value;
              }

              if (field === 'label') {
                needSlugUpdate = true;
              }
            }
          }
        }
      }
    });

    this.sync = sync;

    if (needSlugUpdate && userID) {
      try {
        await this.updateSlug(userID, this.originalLanguage || 'en');
      } catch (error) {
        const serializedError = error instanceof Error ? error : new Error(String(error));
        debug.error('Failed to update slug after sync:');
        debug.error({ error: serializedError });
      }
    }

    await this.save();

    (search as { indexThing?: (thing: ThingInstance) => void }).indexThing?.(this);

    return this;

    function _organizeDataBySource(
      results: Array<AdapterLookupResult | undefined>
    ): Record<string, AdapterLookupData[]> {
      const rv: Record<string, AdapterLookupData[]> = {};
      results.forEach(result => {
        if (result && typeof result.sourceID === 'string' && typeof result.data === 'object') {
          if (!Array.isArray(rv[result.sourceID])) {
            rv[result.sourceID] = [];
          }
          rv[result.sourceID].unshift(result.data);
        }
      });
      return rv;
    }
  },
  /**
   * List the identifiers of sources currently configured for synchronization.
   *
   * @returns Source identifiers for active sync entries
   */
  getSourceIDsOfActiveSyncs(this: ThingInstance) {
    const sync = this.sync as SyncData | undefined;
    const rv: string[] = [];
    if (!sync) {
      return rv;
    }
    for (const [, entry] of Object.entries(sync) as [SyncField, SyncEntry][]) {
      if (entry?.active && entry.source && !rv.includes(entry.source)) {
        rv.push(entry.source);
      }
    }
    return rv;
  },
  /**
   * Fetch up to fifty reviews authored by the provided user for this Thing.
   *
   * @param user - Viewer requesting their own reviews
   * @returns Reviews authored by the user (if any)
   */
  async getReviewsByUser(
    this: ThingInstance,
    user: UserAccessContext | null | undefined
  ): Promise<ReviewInstance[]> {
    if (!user || !user.id) {
      return [];
    }

    try {
      const feed = await Review.getFeed({
        thingID: this.id,
        createdBy: user.id,
        withThing: false,
        withTeams: true,
        limit: 50,
      });

      const reviews = Array.isArray(feed.feedItems) ? (feed.feedItems as ReviewInstance[]) : [];

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
  },
  /**
   * Calculate the average star rating for this Thing across all reviews.
   *
   * @returns Average star rating (not rounded)
   */
  async getAverageStarRating(this: ThingInstance): Promise<number> {
    try {
      if (typeof this.id !== 'string' || this.id.length === 0) {
        return 0;
      }
      const avg = await Review.filterWhere({ thingID: this.id }).average('starRating');
      return typeof avg === 'number' ? avg : 0;
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error('Error calculating average star rating:');
      debug.error({ error: serializedError });
      return 0;
    }
  },
  /**
   * Count the number of reviews associated with this Thing.
   *
   * @returns Number of reviews
   */
  async getReviewCount(this: ThingInstance): Promise<number> {
    try {
      if (typeof this.id !== 'string' || this.id.length === 0) {
        return 0;
      }
      return await Review.filterWhere({ thingID: this.id }).count();
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error('Error counting reviews:');
      debug.error({ error: serializedError });
      return 0;
    }
  },
  /**
   * Append a file record to the Thing's file collection, initializing the
   * array if necessary.
   *
   * @param file - File object to add
   */
  addFile(this: ThingInstance, file: FileInstance) {
    if (!Array.isArray(this.files)) {
      this.files = [];
    }
    this.files.push(file);
  },
  /**
   * Ensure the Thing has a canonical slug, persisting changes when necessary.
   *
   * @param userID - User responsible for the slug update
   * @param language - Preferred language for slug generation
   * @returns The updated Thing instance
   */
  async updateSlug(this: ThingInstance, userID: string, language?: string): Promise<ThingInstance> {
    const originalLanguage = this.originalLanguage || 'en';
    const slugLanguage = language || originalLanguage;

    if (slugLanguage !== originalLanguage) {
      return this;
    }

    if (!this.label) {
      return this;
    }

    const resolved = mlString.resolve(slugLanguage, this.label as Record<string, string>);
    if (!resolved || typeof resolved.str !== 'string' || !resolved.str.trim()) {
      return this;
    }

    let baseSlug;
    try {
      baseSlug = generateSlugName(resolved.str);
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
      const savedSlug = await slug.qualifiedSave();
      if (savedSlug?.name) {
        this.canonicalSlugName = savedSlug.name;
      }
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error('Failed to update Thing slug:');
      debug.error({ error: serializedError });
    }

    return this;
  },
  /**
   * Obtain file records for the provided identifiers and associate them with
   * this Thing, persisting the junction table entries.
   *
   * @param fileIDs - Identifiers of files to attach
   * @param userID - Require that files were uploaded by this user when set
   * @returns The updated Thing instance
   */
  async addFilesByIDsAndSave(
    this: ThingInstance,
    fileIDs: string[],
    userID?: string
  ): Promise<ThingInstance> {
    if (!Array.isArray(fileIDs) || fileIDs.length === 0) {
      return this;
    }

    const uniqueIDs = [...new Set(fileIDs.filter(id => typeof id === 'string' && id.length))];
    if (uniqueIDs.length === 0) {
      return this;
    }

    try {
      const { in: inOp } = File.ops;
      const validFiles = (
        await File.filterWhere({ id: inOp(uniqueIDs as [string, ...string[]]) }).run()
      ).filter(file => !userID || file.uploadedBy === userID);

      if (!validFiles.length) {
        return this;
      }

      // Insert associations into junction table using DAL helper
      const Thing = this.constructor as ThingModel;
      await Thing.addManyRelated(
        'files',
        this.id!,
        validFiles.map(f => f.id!)
      );

      // Update in-memory representation
      const currentFiles = this.files ?? [];
      const existingIDs = new Set(currentFiles.map(file => file.id));
      validFiles.forEach(file => {
        if (!existingIDs.has(file.id)) {
          currentFiles.push(file);
          existingIDs.add(file.id);
        }
      });
      this.files = currentFiles;
    } catch (error) {
      const serializedError = error instanceof Error ? error : new Error(String(error));
      debug.error('Failed to associate files with Thing:');
      debug.error({ error: serializedError });
      throw error;
    }

    return this;
  },
}) satisfies ThingInstanceMethods;

const Thing = defineModel(thingManifest, {
  staticMethods: thingStaticMethods,
  instanceMethods: thingInstanceMethods,
}) as ThingModel;

// Helper functions

async function _attachUploadersToFiles(files: FileInstance[]): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) {
    return;
  }

  const uploaderIDs: string[] = [];
  const seen = new Set<string>();
  files.forEach(file => {
    const uploaderID = file?.uploadedBy;
    if (typeof uploaderID === 'string' && !seen.has(uploaderID)) {
      seen.add(uploaderID);
      uploaderIDs.push(uploaderID);
    }
  });

  if (!uploaderIDs.length) {
    return;
  }

  try {
    const uploaderMap = await fetchUserPublicProfiles(uploaderIDs);

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
  const entries = Object.entries(metadata as Partial<MetadataData>);
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

export default Thing;
