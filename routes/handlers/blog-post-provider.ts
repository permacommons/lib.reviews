// External dependencies
import config from 'config';
import { resolve as resolveURL } from 'node:url';
import i18n from 'i18n';

// Internal dependencies
import type { HandlerRequest, HandlerResponse, HandlerNext } from '../../types/http/handlers.ts';
import AbstractBREADProvider from './abstract-bread-provider.ts';
import BlogPost from '../../models/blog-post.ts';
import mlString from '../../dal/lib/ml-string.ts';
import languages from '../../locales/languages.ts';
import type { LocaleCodeWithUndetermined } from '../../locales/languages.ts';
import feeds from '../helpers/feeds.ts';
import slugs from '../helpers/slugs.ts';
import frontendMessages from '../../util/frontend-messages.ts';

type BlogPostFormValues = {
  title: Record<string, string>;
  text: Record<string, string>;
  html: Record<string, string>;
  createdBy?: string;
  createdOn?: Date;
  creator?: unknown;
  teamID?: string;
  originalLanguage?: string;
  [key: string]: any;
};

type BlogPostInstance = BlogPostFormValues & {
  id: string;
  _revDate?: Date;
  populateUserInfo: (user: HandlerRequest['user']) => void;
  userCanEdit?: boolean;
  userCanDelete?: boolean;
  newRevision: (user: HandlerRequest['user'], options?: Record<string, unknown>) => Promise<BlogPostInstance>;
  deleteAllRevisions: (user: HandlerRequest['user'], options?: Record<string, unknown>) => Promise<unknown>;
  save: () => Promise<BlogPostInstance>;
};

type BlogPostCollectionResult = {
  blogPosts: BlogPostInstance[];
  offsetDate?: Date;
};

type BlogPostModelHandle = {
  getMostRecentBlogPosts: (
    teamID: string,
    options?: { limit?: number; offsetDate?: Date | null }
  ) => Promise<BlogPostCollectionResult>;
  getWithCreator: (id: string) => Promise<BlogPostInstance>;
  createFirstRevision: (
    user: HandlerRequest['user'],
    options?: Record<string, unknown>
  ) => Promise<BlogPostInstance>;
} & Record<string, unknown>;

type TeamInstance = {
  id: string;
  urlID: string;
  name: Record<string, string>;
  populateUserInfo: (user: HandlerRequest['user']) => void;
  userCanBlog?: boolean;
  userCanDelete?: boolean;
  userCanEdit?: boolean;
  userIsMember?: boolean;
  files?: unknown[];
  [key: string]: unknown;
};

const BlogPostModel = BlogPost as unknown as BlogPostModelHandle;

class BlogPostProvider extends AbstractBREADProvider {
  static formDefs: Record<string, any>;
  protected language?: LocaleCodeWithUndetermined;
  protected utcISODate?: string;
  protected postID!: string;
  protected isPreview = false;
  protected editing = false;

  constructor(req: HandlerRequest, res: HandlerResponse, next: HandlerNext, options?: Record<string, unknown>) {
    super(req, res, next, options);
    this.actions.browse.titleKey = 'team blog';
    this.actions.add.titleKey = 'new blog post';
    this.actions.edit.titleKey = 'edit blog post';
    this.actions.delete.titleKey = 'delete blog post';
    this.actions.add.loadData = this.loadData;
    this.actions.add.resourcePermissionCheck = this.userCanAdd;
    this.actions.browse.loadData = this.loadData;

    // All the below are variations of browsing a blog's feed
    this.actions.browseBefore = this.actions.browse;
    this.actions.browseAtom = this.actions.browse;
    this.actions.browseAtomDetectLanguage = this.actions.browse;

    // The base level class is checking the team permissions, but post-level
    // permissions, once created, are independent of team permissions, and
    // handled separately
    this.actions.edit.resourcePermissionCheck = undefined;
    this.actions.delete.resourcePermissionCheck = undefined;

    // Team lookup failures take precedence, post lookup failures handled below
    this.messageKeyPrefix = 'team';

  }

  async browse_GET(team: TeamInstance): Promise<void> {

    if (this.action == 'browseAtomDetectLanguage')
      return this.res.redirect(`/team/${team.urlID}/blog/atom/${this.req.locale}`);

    if (this.language && !languages.isValid(this.language))
      this.language = 'en';

    // Ensure that all i18n for feeds is done using the specified language
    if (this.language)
      i18n.setLocale(this.req, this.language);

    team.populateUserInfo(this.req.user);
    let offsetDate: Date | null = null;
    if (typeof this.utcISODate === 'string') {
      const parsedDate = new Date(this.utcISODate);
      offsetDate = Number.isNaN(parsedDate.valueOf()) ? null : parsedDate;
    }

    BlogPostModel.getMostRecentBlogPosts(team.id, {
        limit: 10,
        offsetDate
      })
      .then(result => {
        const blogPosts = result.blogPosts;
        const nextOffsetDate = result.offsetDate;

        // For Atom feed -- most recently updated item among the selected posts
        let updatedDate;
        blogPosts.forEach(post => {
           post.populateUserInfo(this.req.user);
           if (!updatedDate || post._revDate > updatedDate)
             updatedDate = post._revDate;
        });


        let atomURLPrefix = `/team/${team.urlID}/blog/atom`;
        let atomURLTitleKey = 'atom feed of blog posts by team';
        let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
          atomURLPrefix,
          atomURLTitleKey
        });

        const currentLocale = typeof this.req.locale === 'string' ? this.req.locale : 'en';
        const vars = {
          titleKey: this.actions[this.action].titleKey,
          titleParam: mlString.resolve(currentLocale, team.name).str,
          blogPosts,
          blogPostsUTCISODate: nextOffsetDate ? nextOffsetDate.toISOString() : undefined,
          team,
          teamURL: `/team/${team.urlID}`,
          embeddedFeeds,
          deferPageHeader: true // link in title
        };

        if (this.action == 'browseAtom') {
          const feedLanguage = this.language ?? currentLocale;
          Object.assign(vars, {
            layout: 'layout-atom',
            language: feedLanguage,
            updatedDate,
            selfURL: resolveURL(config.qualifiedURL, `${atomURLPrefix}/${feedLanguage}`),
            htmlURL: resolveURL(config.qualifiedURL, `/team/${team.urlID}/blog`)
          });
          this.res.type('application/atom+xml');
          this.renderTemplate('blog-feed-atom', vars);
        } else {
          this.renderTemplate('team-blog', vars);
        }
      })
      .catch(this.next);
  }

  async read_GET(team: TeamInstance): Promise<void> {
    BlogPostModel
      .getWithCreator(this.postID)
      .then(blogPost => {

        blogPost.populateUserInfo(this.req.user);

        let pageMessages = this.req.flash('pageMessages');
        const requestLanguage = typeof this.req.language === 'string'
          ? this.req.language
          : (typeof this.req.locale === 'string' ? this.req.locale : blogPost.originalLanguage ?? 'en');

        this.renderTemplate('blog-post', {
          team,
          blogPost,
          titleKey: 'blog post page title',
          titleParam: mlString.resolve(requestLanguage, blogPost.title).str,
          teamURL: `/team/${team.urlID}`,
          deferPageHeader: true,
          pageMessages
        });
      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  add_GET(team: TeamInstance, formValues?: BlogPostFormValues): void {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate('blog-post-form', {
      titleKey: this.actions[this.action].titleKey,
      pageErrors: !this.isPreview ? pageErrors : undefined,
      formValues,
      team,
      isPreview: this.isPreview,
      editing: this.editing,
      scripts: ['editor']
    }, {
      messages: frontendMessages.getEditorMessages(typeof this.req.locale === 'string' ? this.req.locale : 'en')
    });

  }

  async edit_GET(team: TeamInstance): Promise<void> {
    BlogPostModel
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanEditPost(blogPost))
          return false;

        this.editing = true;
        this.add_GET(team, blogPost);

      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  async edit_POST(team: TeamInstance): Promise<void> {
    BlogPostModel
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanEditPost(blogPost))
          return false;

        this.editing = true;

        let formKey = 'edit-post';
        const languageBodyValue = this.req.body?.['post-language'];
        const language = typeof languageBodyValue === 'string' ? languageBodyValue : blogPost.originalLanguage ?? 'en';
        const formValues = this.parseForm({
          formDef: BlogPostProvider.formDefs[formKey],
          formKey,
          language
        }).formValues as BlogPostFormValues;

        const postAction = this.req.body?.['post-action'];
        if (postAction === 'preview') {
          // Pass along original authorship info for preview
          formValues.createdOn = blogPost.createdOn;
          formValues.creator = blogPost.creator;
          formValues.originalLanguage = blogPost.originalLanguage;
          this.isPreview = true;
        }

        if (this.isPreview || this.req.flashHas?.('pageErrors'))
          return this.add_GET(team, formValues);

        blogPost.newRevision(this.req.user, {
            tags: ['edit-via-form']
          })
          .then(newRev => {
            newRev.title[language] = formValues.title[language];
            newRev.text[language] = formValues.text[language];
            newRev.html[language] = formValues.html[language];
            newRev.save().then(() => {
                this.req.flash('pageMessages', this.req.__('edit saved'));
                this.res.redirect(`/team/${team.urlID}/post/${newRev.id}`);
              })
              .catch(this.next);
          })
          .catch(this.next);

      })
      .catch(this.getResourceErrorHandler('post', this.postID));

  }

  add_POST(team: TeamInstance): void {

    const postAction = this.req.body?.['post-action'];
    this.isPreview = postAction === 'preview';

    let formKey = 'new-post';
    const languageBodyValue = this.req.body?.['post-language'];
    const language = typeof languageBodyValue === 'string' ? languageBodyValue : 'en';
    const postObj = this.parseForm({
      formDef: BlogPostProvider.formDefs[formKey],
      formKey,
      language
    }).formValues as BlogPostFormValues;

    if (typeof this.req.user?.id === 'string')
      postObj.createdBy = this.req.user.id;
    postObj.createdOn = new Date();
    postObj.creator = this.req.user;
    postObj.teamID = team.id;

    // We're previewing or have basic problems with the submission -- back to form
    if (this.isPreview || this.req.flashHas?.('pageErrors'))
      return this.add_GET(team, postObj);


    BlogPostModel
      .createFirstRevision(this.req.user, {
        tags: ['create-via-form']
      })
      .then(rev => {
        Object.assign(rev, postObj);
        rev
          .save()
          .then(savedRev => {
            this.res.redirect(`/team/${team.urlID}/post/${savedRev.id}`);
          })
          .catch(this.next);
      })
      .catch(this.next); // Problem getting revision metadata
  }

  async delete_GET(team: TeamInstance): Promise<void> {
    BlogPostModel
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanDeletePost(blogPost))
          return false;

        this.renderTemplate('delete-blog-post', {
          team,
          blogPost
        });

      })
      .catch(this.getResourceErrorHandler('post', this.postID).bind(this));

  }

  async delete_POST(): Promise<void> {

    BlogPostModel
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanDeletePost(blogPost))
          return false;

        blogPost.deleteAllRevisions(this.req.user, {
            tags: ['delete-via-form']
          })
          .then(() => {
            this.renderTemplate('post-deleted', {
              titleKey: 'blog post deleted'
            });
          })
          .catch(this.next);

      })
      .catch(this.getResourceErrorHandler('post', this.postID).bind(this));

  }


  userCanAdd(team: TeamInstance): boolean {

    team.populateUserInfo(this.req.user);
    if (!team.userCanBlog) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
      return false;
    }
    return true;
  }

  userCanEditPost(post: BlogPostInstance): boolean {
    post.populateUserInfo(this.req.user);
    if (!post.userCanEdit) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
      return false;
    }
    return true;
  }

  userCanDeletePost(post: BlogPostInstance): boolean {
    post.populateUserInfo(this.req.user);
    if (!post.userCanDelete) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
      return false;
    }
    return true;
  }


  loadData() {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id) as Promise<TeamInstance>;
  }


}

BlogPostProvider.formDefs = {
  'new-post': [{
    name: 'post-title',
    required: true,
    type: 'text',
    key: 'title'
  }, {
    name: 'post-text',
    required: true,
    type: 'markdown',
    key: 'text',
    flat: true,
    htmlKey: 'html'
  }, {
    name: 'post-language',
    required: true,
    key: 'originalLanguage'
  }, {
    name: 'post-action',
    required: true,
    skipValue: true
  }]
};

BlogPostProvider.formDefs['edit-post'] = BlogPostProvider.formDefs['new-post'];

export default BlogPostProvider;
