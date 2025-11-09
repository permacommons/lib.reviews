import { randomUUID } from 'crypto';
import { decodeHTML } from 'entities';
import isUUID from 'is-uuid';
import adapters from '../adapters/adapters.ts';
import dal from '../dal/index.ts';
import { defineModel, defineModelManifest } from '../dal/lib/create-model.ts';
import type { VersionedModelInstance } from '../dal/lib/model-types.ts';
import type { InferConstructor, InferInstance } from '../dal/lib/model-manifest.ts';
import types from '../dal/lib/type.ts';
import languages from '../locales/languages.ts';
import search from '../search.ts';
import debug from '../util/debug.ts';
import ReportedError from '../util/reported-error.ts';
import urlUtils from '../util/url-utils.ts';
import File from './file.ts';

// TODO: Convert Thing/Review to share manifest + type contracts so we can drop
// this lazy import and stick with direct constructor imports again.
async function getReviewModel() {
  const module = await import('./review.ts');
  return module.default;
}
import ThingSlug from './thing-slug.ts';
import User, { type UserViewer } from './user.ts';

const { mlString } = dal as unknown as {
  mlString: Record<string, any>;
};
const { isValid: isValidLanguage } = languages as unknown as { isValid: (code: string) => boolean };

const thingManifest = defineModelManifest({
  tableName: 'things',
  hasRevisions: true,
  schema: {
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
    urlID: types.virtual().default(function (
      this: VersionedModelInstance<Record<string, any>, Record<string, any>>
    ) {
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
    description: types.virtual().default(function (
      this: VersionedModelInstance<Record<string, any>, Record<string, any>>
    ) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.description;
    }),
    subtitle: types.virtual().default(function (
      this: VersionedModelInstance<Record<string, any>, Record<string, any>>
    ) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.subtitle;
    }),
    authors: types.virtual().default(function (
      this: VersionedModelInstance<Record<string, any>, Record<string, any>>
    ) {
      const metadata =
        typeof this.getValue === 'function' ? this.getValue('metadata') : this.metadata;
      return metadata?.authors;
    }),
  },
  camelToSnake: {
    originalLanguage: 'original_language',
    canonicalSlugName: 'canonical_slug_name',
    createdOn: 'created_on',
    createdBy: 'created_by',
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
  ] as const,
  staticMethods: {
    /**
     * Find Thing records associated with a URL, optionally enriching them with
     * reviews authored by the provided user.
     *
     * @param url - URL to look up
     * @param userID - Include reviews authored by this user
     * @returns Matching Thing instances
     */
    async lookupByURL(url: string, userID?: string | null) {
      const tableName = this.tableName ?? 'things';

      const query = `
        SELECT * FROM ${tableName}
        WHERE urls @> ARRAY[$1]
          AND (_old_rev_of IS NULL)
          AND (_rev_deleted IS NULL OR _rev_deleted = false)
      `;

      const result = await this.dal.query(query, [url]);
      const things = result.rows.map(row => this.createFromRow(row as Record<string, unknown>));

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
            const Review = await getReviewModel();
            const reviews = await Review.filterWhere({ createdBy: lookupUserID })
              .whereIn('thingID', thingIDs, { cast: 'uuid[]' })
              .orderBy('created_on', 'DESC')
              .limit(50)
              .run();

            const reviewsByThing = new Map<string, any[]>();
            const viewerForLookup: UserViewer = { id: lookupUserID };

            for (const review of reviews) {
              if (typeof review.populateUserInfo === 'function') {
                review.populateUserInfo(viewerForLookup);
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
      id: string,
      {
        withFiles = true,
        withReviewMetrics = true,
      }: { withFiles?: boolean; withReviewMetrics?: boolean } = {}
    ) {
      const joinOptions: Record<string, any> = {};
      if (withFiles) {
        joinOptions.files = {
          _apply: (seq: any) => seq.filterWhere({ completed: true }),
        };
      }

      const thing = (
        Object.keys(joinOptions).length
          ? await this.getNotStaleOrDeleted(id, joinOptions)
          : await this.getNotStaleOrDeleted(id)
      ) as Record<string, any>;

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
    getLabel(thing: Record<string, any> | null | undefined, language: string) {
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

      if (Array.isArray(thing.urls) && thing.urls.length) {
        return urlUtils.prettify(thing.urls[0]);
      }

      return undefined;
    },
  },
  instanceMethods: {
    /**
     * Initialize Thing fields using the result of an adapter lookup.
     *
     * @param adapterResult - Result object returned from a backend adapter
     */
    initializeFieldsFromAdapter(adapterResult: Record<string, any>) {
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
    },
    /**
     * Populate virtual permission flags for the given viewer.
     *
     * @param user - Viewer whose permissions should be reflected on the instance
     */
    populateUserInfo(user: UserViewer | null | undefined) {
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
    async populateReviewMetrics() {
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
    setURLs(urls: string[]) {
      if (typeof this.sync === 'object' && this.sync) {
        for (const field in this.sync as Record<string, any>) {
          const syncValue = (this.sync as Record<string, any>)[field];
          if (syncValue) {
            syncValue.active = false;
          }
        }
      }

      urls.forEach(url => {
        adapters.getAll().forEach(adapter => {
          if (adapter.ask(url)) {
            adapter.getSupportedFields().forEach(field => {
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
    },
    /**
     * Fetch new external data for all active sync sources.
     *
     * @param userID - User responsible for any slug updates
     * @returns The updated Thing instance
     */
    async updateActiveSyncs(userID?: string) {
      const thing = this as Record<string, any>;

      if (!thing.urls || !thing.urls.length) {
        return thing;
      }

      if (typeof thing.sync !== 'object') {
        thing.sync = {};
      }

      const sources: string[] = [];
      for (const field in thing.sync as Record<string, any>) {
        const syncEntry = (thing.sync as Record<string, any>)[field];
        if (syncEntry?.active && syncEntry.source && !sources.includes(syncEntry.source)) {
          sources.push(syncEntry.source);
        }
      }

      const promises: Promise<Record<string, any> | undefined>[] = [];
      const allURLs: string[] = [];

      sources.forEach(source => {
        const adapter = adapters.getAdapterForSource(source) as Record<string, any>;
        const relevantURLs = thing.urls.filter((url: string) => adapter.ask(url));
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
          `Retrieving item metadata for ${thing.id} from the following URL(s):\n` +
            allURLs.join(', ')
        );
      }

      const results = await Promise.all(promises);
      let needSlugUpdate = false;

      const dataBySource = _organizeDataBySource(results);

      sources.forEach(source => {
        for (const field in thing.sync as Record<string, any>) {
          const syncEntry = (thing.sync as Record<string, any>)[field];
          if (
            syncEntry?.active &&
            syncEntry.source === source &&
            Array.isArray(dataBySource[source])
          ) {
            for (const data of dataBySource[source]) {
              if (data[field] !== undefined) {
                const newSync = { ...(thing.sync as Record<string, any>) };
                newSync[field] = { ...newSync[field], updated: new Date() };
                thing.sync = newSync;

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

      if (needSlugUpdate && userID) {
        try {
          await thing.updateSlug(userID, thing.originalLanguage || 'en');
        } catch (error) {
          const serializedError = error instanceof Error ? error : new Error(String(error));
          debug.error('Failed to update slug after sync:');
          debug.error({ error: serializedError });
        }
      }

      await thing.save();

      (search as Record<string, any>).indexThing?.(thing);

      return thing;

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
    },
    /**
     * List the identifiers of sources currently configured for synchronization.
     *
     * @returns Source identifiers for active sync entries
     */
    getSourceIDsOfActiveSyncs() {
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
    },
    /**
     * Fetch up to fifty reviews authored by the provided user for this Thing.
     *
     * @param user - Viewer requesting their own reviews
     * @returns Reviews authored by the user (if any)
     */
    async getReviewsByUser(user: UserViewer | null | undefined) {
      if (!user || !user.id) {
        return [];
      }

      try {
        const Review = await getReviewModel();
        const feed = await Review.getFeed({
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
    },
    /**
     * Calculate the average star rating for this Thing across all reviews.
     *
     * @returns Average star rating (not rounded)
     */
    async getAverageStarRating() {
      try {
        const runtime = this.constructor as Record<string, any>;
        const dalInstance = runtime.dal as Record<string, any>;
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

        const result = await dalInstance.query(query, [String(this.id)]);
        const avg = result.rows[0]?.avg_rating;
        return typeof avg === 'number' ? avg : parseFloat(String(avg ?? 0));
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
    async getReviewCount() {
      try {
        const runtime = this.constructor as Record<string, any>;
        const dalInstance = runtime.dal as Record<string, any>;
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

        const result = await dalInstance.query(query, [String(this.id)]);
        const count = result.rows[0]?.review_count;
        return parseInt(String(count ?? 0), 10);
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
    addFile(file: Record<string, any>) {
      if (this.files === undefined) {
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
    async updateSlug(userID: string, language?: string) {
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
          const changedSet = this._changed as Set<string> | undefined;
          const runtime = this.constructor as Record<string, any>;
          const dbFieldName =
            typeof runtime._getDbFieldName === 'function'
              ? runtime._getDbFieldName('canonicalSlugName')
              : 'canonical_slug_name';
          changedSet?.add(dbFieldName);
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
    async addFilesByIDsAndSave(fileIDs: string[], userID?: string) {
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

        const result = await File.dal.query(query, uniqueIDs);
        const validFiles = result.rows
          .map(row => File.createFromRow(row as Record<string, unknown>))
          .filter(file => !userID || file.uploadedBy === userID);

        if (!validFiles.length) {
          return this;
        }

        const runtime = this.constructor as Record<string, any>;
        const dalInstance = runtime.dal as Record<string, any>;
        const junctionTable = dalInstance.schemaNamespace
          ? `${dalInstance.schemaNamespace}thing_files`
          : 'thing_files';
        const insertValues: Array<string | undefined> = [];
        const valueClauses: string[] = [];
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

        const existingIDs = new Set((this.files || []).map((file: Record<string, any>) => file.id));
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
    },
  },
} as const);

const Thing = defineModel(thingManifest);

export type ThingInstance = InferInstance<typeof thingManifest>;
export type ThingModel = InferConstructor<typeof thingManifest>;

export default Thing;

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
    const result = await User.filterWhere({}).whereIn('id', uploaderIDs, { cast: 'uuid[]' }).run();

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
