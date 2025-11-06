import dal from '../dal/index.ts';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import { createModel } from '../dal/lib/create-model.ts';
import types from '../dal/lib/type.ts';
import type { VersionedModelConstructor } from '../dal/lib/model-types.ts';
import languages from '../locales/languages.ts';
import debug from '../util/debug.ts';
import User from './user.ts';

const { mlString } = dal as {
  mlString: typeof import('../dal/lib/ml-string.ts').default;
};
const { isValid: isValidLanguage } = languages as {
  isValid: (code: string) => boolean;
};

// TODO(dal-phase-4): Replace loose TeamSlug typing once manifest handles expose exact constructors.
let teamSlugHandlePromise: Promise<Record<string, any>> | null = null;
async function loadTeamSlugHandle(): Promise<Record<string, any>> {
  if (!teamSlugHandlePromise) {
    teamSlugHandlePromise = import('./team-slug.ts').then(
      module => module.default as Record<string, any>
    );
  }
  return teamSlugHandlePromise;
}

interface BlogPostFeedOptions {
  limit?: number;
  offsetDate?: Date;
}

const blogPostManifest = {
  tableName: 'blog_posts',
  hasRevisions: true,
  schema: {
    id: types.string().uuid(4),
    teamID: types.string().uuid(4).required(true),
    title: mlString.getSchema({ maxLength: 100 }),
    text: mlString.getSchema(),
    html: mlString.getSchema(),
    createdOn: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4).required(true),
    originalLanguage: types.string().max(4).required(true).validator(isValidLanguage),
    userCanEdit: types.virtual().default(false),
    userCanDelete: types.virtual().default(false),
  },
  camelToSnake: {
    teamID: 'team_id',
    createdOn: 'created_on',
    createdBy: 'created_by',
    originalLanguage: 'original_language',
  },
  staticMethods: {
    getWithCreator,
    getMostRecentBlogPosts,
    getMostRecentBlogPostsBySlug,
  },
  instanceMethods: {
    populateUserInfo,
  },
} as const;

const BlogPost = createModel(blogPostManifest) as VersionedModelConstructor & Record<string, any>;

/**
 * Retrieve a blog post along with the creator metadata.
 * @param id Blog post identifier to look up.
 * @returns Blog post instance or null when not found.
 */
async function getWithCreator(this: Record<string, any>, id: string) {
  const model = (this ?? BlogPost) as Record<string, any>;
  const post = await model.getNotStaleOrDeleted(id);
  if (!post) {
    return null;
  }
  await attachCreator(model, post);
  return post;
}

/**
 * Fetch a paginated feed of the most recent blog posts for a team.
 * @param teamID Team identifier to scope the feed.
 * @param options Pagination options.
 * @param options.limit Maximum number of entries to return.
 * @param options.offsetDate Optional upper bound for creation date.
 * @returns Feed payload containing posts plus a next-offset marker.
 */
async function getMostRecentBlogPosts(
  this: Record<string, any>,
  teamID: string,
  { limit = 10, offsetDate }: BlogPostFeedOptions = {}
) {
  if (!teamID) {
    throw new Error('We require a team ID to fetch blog posts.');
  }

  const model = (this ?? BlogPost) as Record<string, any>;
  const dalInstance = model.dal;
  const postsTable = model.tableName;
  const params: unknown[] = [teamID];
  let paramIndex = 2;

  let query = `
    SELECT *
    FROM ${postsTable}
    WHERE team_id = $1
      AND (_rev_deleted IS NULL OR _rev_deleted = false)
      AND (_old_rev_of IS NULL)
  `;

  if (offsetDate) {
    query += ` AND created_on < $${paramIndex}`;
    params.push(offsetDate);
    paramIndex++;
  }

  query += ` ORDER BY created_on DESC LIMIT $${paramIndex}`;
  params.push(limit + 1);

  const result = await dalInstance.query(query, params);

  const posts = await Promise.all(
    result.rows.map(async row => {
      const post = model._createInstance(row);
      await attachCreator(model, post);
      return post;
    })
  );

  const blogPosts = posts.filter(Boolean);

  const response: { blogPosts: typeof blogPosts; offsetDate?: Date } = { blogPosts };

  if (blogPosts.length === limit + 1 && limit > 0) {
    const offsetPost = blogPosts[limit - 1];
    response.offsetDate = offsetPost.createdOn;
    blogPosts.pop();
  }

  return response;
}

/**
 * Fetch a paginated feed of the most recent blog posts for a team slug.
 * @param teamSlugName Slug identifier used to resolve the team.
 * @param options Pagination options forwarded to the team-based fetch.
 * @returns Feed payload for the resolved team.
 */
async function getMostRecentBlogPostsBySlug(
  this: Record<string, any>,
  teamSlugName: string,
  options?: BlogPostFeedOptions
) {
  const TeamSlug = await loadTeamSlugHandle();
  const slug = await TeamSlug.getByName(teamSlugName);
  if (!slug || !slug.teamID) {
    throw new DocumentNotFound(`Slug '${teamSlugName}' not found for team`);
  }
  return getMostRecentBlogPosts.call(this, slug.teamID, options);
}

/**
 * Populate virtual permission flags for the given user on this blog post.
 * @param user User whose permissions should be evaluated.
 */
function populateUserInfo(this: Record<string, any>, user: Record<string, any>) {
  if (!user) {
    return;
  }

  if (user.isSuperUser || user.id === this.createdBy) {
    this.userCanEdit = true;
  }

  if (user.isSuperUser || user.id === this.createdBy || user.isSiteModerator) {
    this.userCanDelete = true;
  }
}

/**
 * Attach creator metadata to a blog post instance.
 * @param model Blog post model used to access the DAL.
 * @param post Blog post instance to decorate.
 * @returns The decorated blog post instance.
 */
async function attachCreator(model: Record<string, any>, post: Record<string, any>) {
  if (!post || !post.createdBy) {
    return post;
  }

  try {
    const user = await User.getWithTeams(post.createdBy);
    if (!user) {
      return post;
    }
    post.creator = {
      id: user.id,
      displayName: user.displayName,
      urlName: user.urlName,
    };
  } catch (error) {
    debug.db('Failed to load blog post creator:', error);
  }

  return post;
}

export default BlogPost;
