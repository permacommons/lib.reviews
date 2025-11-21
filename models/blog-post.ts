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
import User, { type UserAccessContext, type UserView } from './user.ts';

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

    const feedPage = await this.filterWhere({ teamID }).chronologicalFeed({
      cursorField: 'createdOn',
      cursor: offsetDate ?? undefined,
      limit,
    });

    const blogPosts = (await Promise.all(
      feedPage.rows.map(async rawPost => {
        const post = rawPost as BlogPostInstance;
        await attachCreator(this, post);
        return post;
      })
    )) as BlogPostInstance[];

    return {
      blogPosts,
      offsetDate: feedPage.hasMore ? feedPage.nextCursor : undefined,
    };
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
  populateUserInfo(this: BlogPostInstance, user: UserAccessContext | null | undefined) {
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
    const [creator] = await User.fetchView<UserView>('publicProfile', {
      configure(builder) {
        builder.whereIn('id', [post.createdBy as string], { cast: 'uuid[]' });
      },
    });
    if (!creator) {
      return post;
    }
    post.creator = {
      id: creator.id,
      displayName: creator.displayName,
      urlName: creator.urlName,
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
