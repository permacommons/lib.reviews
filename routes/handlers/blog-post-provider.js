'use strict';

// External dependencies
const config = require('config');
const url = require('url');
const i18n = require('i18n');

// Internal dependencies
const AbstractBREADProvider = require('./abstract-bread-provider');
const { getPostgresBlogPostModel } = require('../../models-postgres/blog-post');
const mlString = require('../../dal/lib/ml-string.js');
const languages = require('../../locales/languages');
const feeds = require('../helpers/feeds');
const slugs = require('../helpers/slugs');
const { getEditorMessages } = require('../../util/frontend-messages');

class BlogPostProvider extends AbstractBREADProvider {

  constructor(req, res, next, options) {
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

  async browse_GET(team) {

    if (this.action == 'browseAtomDetectLanguage')
      return this.res.redirect(`/team/${team.urlID}/blog/atom/${this.req.locale}`);

    if (this.language && !languages.isValid(this.language))
      this.language = 'en';

    // Ensure that all i18n for feeds is done using the specified language
    if (this.language)
      i18n.setLocale(this.req, this.language);

    let offsetDate;

    team.populateUserInfo(this.req.user);

    offsetDate = new Date(this.utcISODate);
    if (!offsetDate || offsetDate == 'Invalid Date')
      offsetDate = null;

    const BlogPost = await getPostgresBlogPostModel();
    BlogPost.getMostRecentBlogPosts(team.id, {
        limit: 10,
        offsetDate
      })
      .then(result => {
        let blogPosts = result.blogPosts;
        let offsetDate = result.offsetDate;

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

        let vars = {
          titleKey: this.actions[this.action].titleKey,
          titleParam: mlString.resolve(this.req.locale, team.name).str,
          blogPosts,
          blogPostsUTCISODate: offsetDate ? offsetDate.toISOString() : undefined,
          team,
          teamURL: `/team/${team.urlID}`,
          embeddedFeeds,
          deferPageHeader: true // link in title
        };

        if (this.action == 'browseAtom') {
          Object.assign(vars, {
            layout: 'layout-atom',
            language: this.language,
            updatedDate,
            selfURL: url.resolve(config.qualifiedURL, `${atomURLPrefix}/${this.language}`),
            htmlURL: url.resolve(config.qualifiedURL, `/team/${team.urlID}/blog`)
          });
          this.res.type('application/atom+xml');
          this.renderTemplate('blog-feed-atom', vars);
        } else {
          this.renderTemplate('team-blog', vars);
        }
      })
      .catch(this.next);
  }

  async read_GET(team) {
    const BlogPost = await getPostgresBlogPostModel();
    BlogPost
      .getWithCreator(this.postID)
      .then(blogPost => {

        blogPost.populateUserInfo(this.req.user);

        let pageMessages = this.req.flash('pageMessages');

        this.renderTemplate('blog-post', {
          team,
          blogPost,
          titleKey: 'blog post page title',
          titleParam: mlString.resolve(this.req.language, blogPost.title).str,
          teamURL: `/team/${team.urlID}`,
          deferPageHeader: true,
          pageMessages
        });
      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  add_GET(team, formValues) {
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
      messages: getEditorMessages(this.req.locale)
    });

  }

  async edit_GET(team) {
    const BlogPost = await getPostgresBlogPostModel();
    BlogPost
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanEditPost(blogPost))
          return false;

        this.editing = true;
        this.add_GET(team, blogPost);

      })
      .catch(this.getResourceErrorHandler('post', this.postID));
  }

  async edit_POST(team) {
    const BlogPost = await getPostgresBlogPostModel();
    BlogPost
      .getWithCreator(this.postID)
      .then(blogPost => {

        if (!this.userCanEditPost(blogPost))
          return false;

        this.editing = true;

        let formKey = 'edit-post';
        let language = this.req.body['post-language'];
        let formValues = this.parseForm({
          formDef: BlogPostProvider.formDefs[formKey],
          formKey,
          language
        }).formValues;

        if (this.req.body['post-action'] == 'preview') {
          // Pass along original authorship info for preview
          formValues.createdOn = blogPost.createdOn;
          formValues.creator = blogPost.creator;
          formValues.originalLanguage = blogPost.originalLanguage;
          this.isPreview = true;
        }

        if (this.isPreview || this.req.flashHas('pageErrors'))
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

  add_POST(team) {

    this.isPreview = this.req.body['post-action'] == 'preview' ? true : false;

    let formKey = 'new-post';
    let language = this.req.body['post-language'];
    let postObj = this.parseForm({
      formDef: BlogPostProvider.formDefs[formKey],
      formKey,
      language
    }).formValues;

    postObj.createdBy = this.req.user.id;
    postObj.createdOn = new Date();
    postObj.creator = this.req.user;
    postObj.teamID = team.id;

    // We're previewing or have basic problems with the submission -- back to form
    if (this.isPreview || this.req.flashHas('pageErrors'))
      return this.add_GET(team, postObj);


    BlogPost
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

  async delete_GET(team) {
    const BlogPost = await getPostgresBlogPostModel();
    BlogPost
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

  async delete_POST() {

    const BlogPost = await getPostgresBlogPostModel();
    BlogPost
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


  userCanAdd(team) {

    team.populateUserInfo(this.req.user);
    if (!team.userCanBlog) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
    } else
      return true;
  }

  userCanEditPost(post) {
    post.populateUserInfo(this.req.user);
    if (!post.userCanEdit) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
    } else
      return true;
  }

  userCanDeletePost(post) {
    post.populateUserInfo(this.req.user);
    if (!post.userCanDelete) {
      this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });
    } else
      return true;
  }


  loadData() {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id);
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

module.exports = BlogPostProvider;
