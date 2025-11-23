import dal from '../../dal/index.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferConstructor,
  InferData,
  InferInstance,
  InferVirtual,
  ModelManifest,
} from '../../dal/lib/model-manifest.ts';
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

type BlogPostInstanceBase = InferInstance<typeof blogPostManifest>;
type BlogPostModelBase = InferConstructor<typeof blogPostManifest>;

export type BlogPostData = InferData<(typeof blogPostManifest)['schema']>;
export type BlogPostVirtual = InferVirtual<(typeof blogPostManifest)['schema']>;

export interface BlogPostInstanceMethods {
  populateUserInfo(
    this: BlogPostInstanceBase & BlogPostInstanceMethods,
    user: UserAccessContext | null | undefined
  ): void;
}

export interface BlogPostStaticMethods {
  getWithCreator(
    this: BlogPostModelBase & BlogPostStaticMethods,
    id: string
  ): Promise<BlogPostInstance | null>;
  getMostRecentBlogPosts(
    this: BlogPostModelBase & BlogPostStaticMethods,
    teamID: string,
    options?: BlogPostFeedOptions
  ): Promise<{ blogPosts: BlogPostInstance[]; offsetDate?: Date }>;
  getMostRecentBlogPostsBySlug(
    this: BlogPostModelBase & BlogPostStaticMethods,
    teamSlugName: string,
    options?: BlogPostFeedOptions
  ): Promise<{ blogPosts: BlogPostInstance[]; offsetDate?: Date }>;
}

// Use intersection pattern for relation types
export type BlogPostInstance = BlogPostInstanceBase &
  BlogPostInstanceMethods & {
    creator?: BlogPostCreator;
  };
export type BlogPostModel = BlogPostModelBase & BlogPostStaticMethods;

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
