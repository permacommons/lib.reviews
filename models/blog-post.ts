import {
  defineInstanceMethods,
  defineModel,
  defineStaticMethods,
} from '../dal/lib/create-model.ts';
import { DocumentNotFound } from '../dal/lib/errors.ts';
import debug from '../util/debug.ts';
import blogPostManifest, {
  type BlogPostFeedOptions,
  type BlogPostInstance,
  type BlogPostInstanceMethods,
  type BlogPostModel,
  type BlogPostStaticMethods,
} from './manifests/blog-post.ts';
import { referenceTeamSlug } from './manifests/team-slug.ts';
import User, { type UserViewer } from './user.ts';

const TeamSlug = referenceTeamSlug();

const blogPostStaticMethods = defineStaticMethods(blogPostManifest, {
  /**
   * Retrieve a blog post along with the creator metadata.
   *
   * @param id - Blog post identifier to look up.
   * @returns Blog post instance or null when not found.
   */
  async getWithCreator(this: BlogPostModel, id: string) {
    const post = (await this.getNotStaleOrDeleted(id)) as BlogPostInstance | null;
    if (!post) {
      return null;
    }

    await attachCreator(this, post);
    return post;
  },
  /**
   * Fetch a paginated feed of the most recent blog posts for a team.
   *
   * @param teamID - Team identifier to scope the feed.
   * @param options - Pagination options controlling the feed.
   * @returns Feed payload containing posts plus a next-offset marker.
   */
  async getMostRecentBlogPosts(
    this: BlogPostModel,
    teamID: string,
    options: BlogPostFeedOptions = {}
  ) {
    const { limit = 10, offsetDate } = options;
    if (!teamID) {
      throw new Error('We require a team ID to fetch blog posts.');
    }

    const params: unknown[] = [teamID];
    let paramIndex = 2;

    let query = `
        SELECT *
        FROM ${this.tableName}
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

    const result = await this.dal.query(query, params);

    const blogPosts = (await Promise.all(
      result.rows.map(async row => {
        const post = this.createFromRow(row as Record<string, unknown>) as BlogPostInstance;
        await attachCreator(this, post);
        return post;
      })
    )) as BlogPostInstance[];

    const response: { blogPosts: BlogPostInstance[]; offsetDate?: Date } = { blogPosts };

    if (blogPosts.length === limit + 1 && limit > 0) {
      const offsetPost = blogPosts[limit - 1];
      response.offsetDate = offsetPost.createdOn;
      blogPosts.pop();
    }

    return response;
  },
  /**
   * Fetch a paginated feed of the most recent blog posts for a team slug.
   *
   * @param teamSlugName - Slug identifier used to resolve the team.
   * @param options - Pagination options forwarded to the team-based fetch.
   * @returns Feed payload for the resolved team.
   */
  async getMostRecentBlogPostsBySlug(
    this: BlogPostModel,
    teamSlugName: string,
    options?: BlogPostFeedOptions
  ) {
    const slug = await TeamSlug.getByName(teamSlugName);
    if (!slug || !slug.teamID) {
      throw new DocumentNotFound(`Slug '${teamSlugName}' not found for team`);
    }
    return this.getMostRecentBlogPosts(slug.teamID, options);
  },
}) satisfies BlogPostStaticMethods;

const blogPostInstanceMethods = defineInstanceMethods(blogPostManifest, {
  populateUserInfo(this: BlogPostInstance, user: UserViewer | null | undefined) {
    if (!user) {
      return;
    }

    const isSuperUser = Boolean(user.isSuperUser);
    const isSiteModerator = Boolean(user.isSiteModerator);
    const isCreator = user.id === this.createdBy;

    if (isSuperUser || isCreator) {
      this.userCanEdit = true;
    }

    if (isSuperUser || isCreator || isSiteModerator) {
      this.userCanDelete = true;
    }
  },
}) satisfies BlogPostInstanceMethods;

const BlogPost = defineModel(blogPostManifest, {
  staticMethods: blogPostStaticMethods,
  instanceMethods: blogPostInstanceMethods,
});

/**
 * Attach creator metadata to a blog post instance.
 * @param model Blog post model used to access the DAL.
 * @param post Blog post instance to decorate.
 * @returns The decorated blog post instance.
 */
async function attachCreator(model: BlogPostModel, post: BlogPostInstance) {
  if (!post || !post.createdBy) {
    return post;
  }

  try {
    const user = await User.getWithTeams(post.createdBy);
    if (!user) {
      return post;
    }
    const postRecord = post as BlogPostInstance & Record<string, any>;
    postRecord.creator = {
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

export type {
  BlogPostFeedOptions,
  BlogPostInstance,
  BlogPostInstanceMethods,
  BlogPostModel,
  BlogPostStaticMethods,
} from './manifests/blog-post.ts';
export { referenceBlogPost } from './manifests/blog-post.ts';
