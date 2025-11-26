import dal from '../../dal/index.ts';
import type {
  InstanceMethodsFrom,
  ManifestInstance,
  ManifestTypes,
  StaticMethodsFrom,
} from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type { ModelManifest } from '../../dal/lib/model-manifest.ts';
import languages from '../../locales/languages.ts';
import type { UserAccessContext, UserView } from './user.ts';

export type BlogPostCreator = Pick<UserView, 'id' | 'displayName' | 'urlName'>;

const { mlString, types } = dal;
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

export interface BlogPostFeedOptions {
  limit?: number;
  offsetDate?: Date;
}

const blogPostManifest = {
  tableName: 'blog_posts',
  hasRevisions: true as const,
  schema: {
    id: types.string().uuid(4),
    teamID: types.string().uuid(4).required(true),
    title: mlString.getSafeTextSchema({ maxLength: 100 }),
    text: mlString.getSafeTextSchema(),
    html: mlString.getHTMLSchema(),
    createdOn: types.date().default(() => new Date()),
    createdBy: types.string().uuid(4).required(true),
    originalLanguage: types.string().max(4).required(true).validator(isValidLanguage),
    userCanEdit: types.virtual().default(false),
    userCanDelete: types.virtual().default(false),
    // Note: creator relation is typed via intersection pattern on BlogPostInstance
  },
  camelToSnake: {
    teamID: 'team_id',
    createdOn: 'created_on',
    createdBy: 'created_by',
    originalLanguage: 'original_language',
  },
} as const satisfies ModelManifest;

type BlogPostRelations = { creator?: BlogPostCreator };

export type BlogPostInstanceMethods = InstanceMethodsFrom<
  typeof blogPostManifest,
  {
    populateUserInfo(user: UserAccessContext | null | undefined): void;
  },
  BlogPostRelations
>;

export type BlogPostInstance = ManifestInstance<typeof blogPostManifest, BlogPostInstanceMethods> &
  BlogPostRelations;

export type BlogPostStaticMethods = StaticMethodsFrom<
  typeof blogPostManifest,
  {
    getWithCreator(id: string): Promise<BlogPostInstance | null>;
    getMostRecentBlogPosts(
      teamID: string,
      options?: BlogPostFeedOptions
    ): Promise<{ blogPosts: BlogPostInstance[]; offsetDate?: Date }>;
    getMostRecentBlogPostsBySlug(
      teamSlugName: string,
      options?: BlogPostFeedOptions
    ): Promise<{ blogPosts: BlogPostInstance[]; offsetDate?: Date }>;
  },
  BlogPostInstanceMethods,
  BlogPostRelations
>;

type BlogPostTypes = ManifestTypes<
  typeof blogPostManifest,
  BlogPostStaticMethods,
  BlogPostInstanceMethods,
  BlogPostRelations
>;

export type BlogPostData = BlogPostTypes['Data'];
export type BlogPostVirtual = BlogPostTypes['Virtual'];
export type BlogPostModel = BlogPostTypes['Model'];

/**
 * Create a lazy reference to the BlogPost model for use in other models.
 * Resolves after bootstrap without causing circular import issues.
 *
 * @returns Typed BlogPost model constructor
 */
export function referenceBlogPost(): BlogPostModel {
  return referenceModel(blogPostManifest) as BlogPostModel;
}

export default blogPostManifest;
