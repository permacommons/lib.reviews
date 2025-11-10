import dal from '../../dal/index.ts';
import { defineModelManifest } from '../../dal/lib/create-model.ts';
import { referenceModel } from '../../dal/lib/model-handle.ts';
import type {
  InferConstructor,
  InferData,
  InferInstance,
  InferVirtual,
} from '../../dal/lib/model-manifest.ts';
import types from '../../dal/lib/type.ts';
import languages from '../../locales/languages.ts';
import type { UserViewer } from './user.ts';

const { mlString } = dal as {
  mlString: typeof import('../../dal/lib/ml-string.ts').default;
};
const { isValid: isValidLanguage } = languages as { isValid: (code: string) => boolean };

export interface BlogPostFeedOptions {
  limit?: number;
  offsetDate?: Date;
}

const blogPostManifest = defineModelManifest({
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
});

type BlogPostInstanceBase = InferInstance<typeof blogPostManifest>;
type BlogPostModelBase = InferConstructor<typeof blogPostManifest>;

export type BlogPostData = InferData<(typeof blogPostManifest)['schema']>;
export type BlogPostVirtual = InferVirtual<(typeof blogPostManifest)['schema']>;

export interface BlogPostInstanceMethods {
  populateUserInfo(
    this: BlogPostInstanceBase & BlogPostInstanceMethods,
    user: UserViewer | null | undefined
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

export type BlogPostInstance = BlogPostInstanceBase & BlogPostInstanceMethods;
export type BlogPostModel = BlogPostModelBase & BlogPostStaticMethods;

export function referenceBlogPost(): BlogPostModel {
  return referenceModel(blogPostManifest) as BlogPostModel;
}

export default blogPostManifest;
