// External dependencies

import { resolve as resolveURL } from 'node:url';
import config from 'config';
import i18n from 'i18n';
import type { LocaleCodeWithUndetermined } from '../../locales/languages.ts';
import languages from '../../locales/languages.ts';
import BlogPostModel, { type BlogPostInstance } from '../../models/blog-post.ts';
import type { TeamInstance } from '../../models/manifests/team.ts';
// Internal dependencies
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import frontendMessages from '../../util/frontend-messages.ts';
import feeds from '../helpers/feeds.ts';
import slugs from '../helpers/slugs.ts';
import AbstractBREADProvider from './abstract-bread-provider.ts';

type BlogPostFormValues = Required<Pick<BlogPostInstance, 'title' | 'text' | 'html'>> &
  Partial<Omit<BlogPostInstance, 'title' | 'text' | 'html'>>;

class BlogPostProvider extends AbstractBREADProvider {
  static formDefs: Record<string, any>;
  protected declare language?: LocaleCodeWithUndetermined;
  protected declare utcISODate?: string;
  protected declare postID: string;
  protected isPreview = false;
  protected editing = false;

  constructor(
    req: HandlerRequest,
    res: HandlerResponse,
    next: HandlerNext,
    options?: Record<string, unknown>
  ) {
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

    if (this.language && !languages.isValid(this.language)) this.language = 'en';

    // Ensure that all i18n for feeds is done using the specified language
    if (this.language) i18n.setLocale(this.req, this.language);

    team.populateUserInfo(this.req.user);
    let offsetDate: Date | null = null;
    if (typeof this.utcISODate === 'string') {
      const parsedDate = new Date(this.utcISODate);
      offsetDate = Number.isNaN(parsedDate.valueOf()) ? null : parsedDate;
    }

    BlogPostModel.getMostRecentBlogPosts(team.id, {
      limit: 10,
      offsetDate,
    })
      .then(result => {
        const blogPosts = result.blogPosts;
        const nextOffsetDate = result.offsetDate;

        // For Atom feed -- most recently updated item among the selected posts
        let updatedDate;
        blogPosts.forEach(post => {
          post.populateUserInfo(this.req.user);
          if (!updatedDate || post._revDate > updatedDate) updatedDate = post._revDate;
        });

        let atomURLPrefix = `/team/${team.urlID}/blog/atom`;
        let atomURLTitleKey = 'atom feed of blog posts by team';
        let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
          atomURLPrefix,
          atomURLTitleKey,
        });

        const currentLocale = typeof this.req.locale === 'string' ? this.req.locale : 'en';
        const resolvedTeamName = this.resolveMlString(currentLocale, team.name);
        const vars = {
          titleKey: this.actions[this.action].titleKey,
          titleParam: resolvedTeamName?.str ?? '',
          blogPosts,
          blogPostsUTCISODate: nextOffsetDate ? nextOffsetDate.toISOString() : undefined,
          team,
          teamURL: `/team/${team.urlID}`,
          embeddedFeeds,
          deferPageHeader: true, // link in title
        };

        if (this.action == 'browseAtom') {
          const feedLanguage = this.language ?? currentLocale;
          Object.assign(vars, {
            layout: 'layout-atom',
            language: feedLanguage,
            updatedDate,
            selfURL: resolveURL(config.qualifiedURL, `${atomURLPrefix}/${feedLanguage}`),
            htmlURL: resolveURL(config.qualifiedURL, `/team/${team.urlID}/blog`),
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
    BlogPostModel.getWithCreator(this.postID)
      .then(blogPost => {
        if (!blogPost) return this.handleMissingResource('post', this.postID);
        blogPost.populateUserInfo(this.req.user);

        let pageMessages = this.req.flash('pageMessages');
        const requestLanguage =
          typeof this.req.language === 'string'
            ? this.req.language
            : typeof this.req.locale === 'string'
              ? this.req.locale
              : (blogPost.originalLanguage ?? 'en');

        this.renderTemplate('blog-post', {
          team,
          blogPost,
          titleKey: 'blog post page title',
          titleParam: this.resolveMlString(requestLanguage, blogPost.title)?.str ?? '',
          teamURL: `/team/${team.urlID}`,
          deferPageHeader: true,
          pageMessages,
        });
      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  add_GET(team: TeamInstance, formValues?: BlogPostFormValues): void {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate(
      'blog-post-form',
      {
        titleKey: this.actions[this.action].titleKey,
        pageErrors: !this.isPreview ? pageErrors : undefined,
        formValues,
        team,
        isPreview: this.isPreview,
        editing: this.editing,
        scripts: ['editor'],
      },
      {
        messages: frontendMessages.getEditorMessages(
          typeof this.req.locale === 'string' ? this.req.locale : 'en'
        ),
      }
    );
  }

  async edit_GET(team: TeamInstance): Promise<void> {
    BlogPostModel.getWithCreator(this.postID)
      .then(blogPost => {
        if (!blogPost) return this.handleMissingResource('post', this.postID);
        if (!this.userCanEditPost(blogPost)) return false;

        this.editing = true;
        this.add_GET(team, blogPost);
      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  async edit_POST(team: TeamInstance): Promise<void> {
    BlogPostModel.getWithCreator(this.postID)
      .then(blogPost => {
        if (!blogPost) return this.handleMissingResource('post', this.postID);
        if (!this.userCanEditPost(blogPost)) return false;

        this.editing = true;

        let formKey = 'edit-post';
        const languageBodyValue = this.req.body?.['post-language'];
        const language =
          typeof languageBodyValue === 'string'
            ? languageBodyValue
            : (blogPost.originalLanguage ?? 'en');
        const formDef = BlogPostProvider.formDefs[formKey];
        if (!formDef) {
          throw new Error(`Form definition '${formKey}' is not registered.`);
        }

        const submission = this.parseData<BlogPostFormValues>({
          formDef,
          formKey,
          language,
          transform: values => this.toBlogPostFormValues(values),
        });
        const { data: formValues } = submission;

        const postAction = this.req.body?.['post-action'];
        if (postAction === 'preview') {
          // Pass along original authorship info for preview
          formValues.createdOn = blogPost.createdOn;
          formValues.creator = blogPost.creator;
          formValues.originalLanguage = blogPost.originalLanguage;
          this.isPreview = true;
        }

        if (this.isPreview || !submission.hasRequiredFields || this.req.flashHas?.('pageErrors'))
          return this.add_GET(team, formValues);

        blogPost
          .newRevision(this.req.user, {
            tags: ['edit-via-form'],
          })
          .then(newRev => {
            newRev.title[language] = formValues.title[language];
            newRev.text[language] = formValues.text[language];
            newRev.html[language] = formValues.html[language];
            newRev
              .save()
              .then(() => {
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
    const formDef = BlogPostProvider.formDefs[formKey];
    if (!formDef) {
      throw new Error(`Form definition '${formKey}' is not registered.`);
    }

    const submission = this.parseData<BlogPostFormValues>({
      formDef,
      formKey,
      language,
      transform: values => this.toBlogPostFormValues(values),
    });
    const { data: postObj } = submission;

    if (typeof this.req.user?.id === 'string') postObj.createdBy = this.req.user.id;
    postObj.createdOn = new Date();
    postObj.creator = this.req.user;
    postObj.teamID = team.id;

    // We're previewing or have basic problems with the submission -- back to form
    if (this.isPreview || !submission.hasRequiredFields || this.req.flashHas?.('pageErrors'))
      return this.add_GET(team, postObj);

    BlogPostModel.createFirstRevision(this.req.user, {
      tags: ['create-via-form'],
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
    BlogPostModel.getWithCreator(this.postID)
      .then(blogPost => {
        if (!blogPost) return this.handleMissingResource('post', this.postID);
        if (!this.userCanDeletePost(blogPost)) return false;

        this.renderTemplate('delete-blog-post', {
          team,
          blogPost,
        });
      })
      .catch(this.getResourceErrorHandler('post', this.postID).bind(this));
  }

  async delete_POST(): Promise<void> {
    BlogPostModel.getWithCreator(this.postID)
      .then(blogPost => {
        if (!blogPost) return this.handleMissingResource('post', this.postID);
        if (!this.userCanDeletePost(blogPost)) return false;

        blogPost
          .deleteAllRevisions(this.req.user, {
            tags: ['delete-via-form'],
          })
          .then(() => {
            this.renderTemplate('post-deleted', {
              titleKey: 'blog post deleted',
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
        titleKey: this.actions[this.action].titleKey,
      });
      return false;
    }
    return true;
  }

  userCanEditPost(post: BlogPostInstance): boolean {
    post.populateUserInfo(this.req.user);
    if (!post.userCanEdit) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
      });
      return false;
    }
    return true;
  }

  userCanDeletePost(post: BlogPostInstance): boolean {
    post.populateUserInfo(this.req.user);
    if (!post.userCanDelete) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
      });
      return false;
    }
    return true;
  }

  loadData(): Promise<TeamInstance> {
    if (!this.id) {
      throw new Error('Team identifier is required to load blog posts.');
    }
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id) as Promise<TeamInstance>;
  }

  private toBlogPostFormValues(formValues: Record<string, unknown>): BlogPostFormValues {
    const typedValues = formValues as Partial<BlogPostInstance>;
    const { title, text, html, ...rest } = typedValues;

    return {
      ...rest,
      title: this.ensureMlString(title),
      text: this.ensureMlString(text),
      html: this.ensureMlString(html),
    } satisfies BlogPostFormValues;
  }
}

BlogPostProvider.formDefs = {
  'new-post': [
    {
      name: 'post-title',
      required: true,
      type: 'text',
      key: 'title',
    },
    {
      name: 'post-text',
      required: true,
      type: 'markdown',
      key: 'text',
      flat: true,
      htmlKey: 'html',
    },
    {
      name: 'post-language',
      required: true,
      key: 'originalLanguage',
    },
    {
      name: 'post-action',
      required: true,
      skipValue: true,
    },
  ],
};

BlogPostProvider.formDefs['edit-post'] = BlogPostProvider.formDefs['new-post'];

export default BlogPostProvider;
