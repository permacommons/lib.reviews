'use strict';
// External deps
const escapeHTML = require('escape-html');
const config = require('config');
const url = require('url');
const i18n = require('i18n');

// Internal deps
const AbstractBREADProvider = require('./abstract-bread-provider');
const Team = require('../../models-postgres/team');
const mlString = require('../../dal/lib/ml-string');
const { getPostgresBlogPostModel } = require('../../models-postgres/blog-post');
const feeds = require('../helpers/feeds');
const slugs = require('../helpers/slugs');
const { getEditorMessages } = require('../../util/frontend-messages');

class TeamProvider extends AbstractBREADProvider {

  constructor(req, res, next, options) {
    super(req, res, next, options);
    this.addPreFlightCheck(['add', 'edit', 'delete'], this.userIsTrusted);
    this.actions.browse.titleKey = 'browse teams';
    this.actions.add.titleKey = 'new team';
    this.actions.edit.titleKey = 'edit team';
    this.actions.delete.titleKey = 'delete team';

    this.actions.read.loadData = this.loadDataWithMostRecentReview;

    // Membership roster
    this.actions.members = {
      GET: this.members_GET,
      loadData: this.loadData,
      titleKey: 'membership roster',
      preFlightChecks: []
    };

    this.actions.feed = {
      GET: this.feed_GET,
      loadData: this.loadDataWithFeed,
      preFlightChecks: [],
      titleKey: 'team feed'
    };

    // Join request management for closed teams
    this.actions.manageRequests = {
      GET: this.manageRequests_GET,
      POST: this.manageRequests_POST,
      loadData: this.loadDataWithJoinRequestDetails,
      titleKey: 'manage team requests',
      preFlightChecks: [this.userIsSignedIn]
    };

    this.messageKeyPrefix = 'team';
  }

  browse_GET() {

    Team
      .getPostgresTeamModel()
      .then(model => {
        if (!model || typeof model.filterNotStaleOrDeleted !== 'function')
          throw new Error('PostgreSQL Team model not initialized');
        return model.filterNotStaleOrDeleted().run();
      })
      .then(teams => {

        this.renderTemplate('teams', {
          teams,
          titleKey: this.actions.browse.titleKey,
          deferPageHeader: true
        });

      })
      .catch(this.next);

  }

  members_GET(team) {

    // For easy lookup in template
    let founder = {
      [team.createdBy]: true
    };
    let moderators = {};
    team.moderators.forEach(moderator => (moderators[moderator.id] = true));

    this.renderTemplate('team-roster', {
      team,
      teamURL: `/team/${team.urlID}`,
      founder,
      moderators,
      titleKey: this.actions.members.titleKey,
      titleParam: mlString.resolve(this.req.locale, team.name).str,
      deferPageHeader: true // embedded link
    });
  }

  manageRequests_GET(team) {

    let pageErrors = this.req.flash('pageErrors');
    let pageMessages = this.req.flash('pageMessages');

    team.populateUserInfo(this.req.user);

    // Don't show rejected requests again. NB - modifying model, no saving.
    team.joinRequests = team.joinRequests.filter(request => !request.rejectionDate);

    if (!team.userIsModerator)
      return this.renderPermissionError();

    this.renderTemplate('team-manage-requests', {
      team,
      teamURL: `/team/${team.urlID}`,
      teamName: mlString.resolve(this.req.locale, team.name).str,
      titleKey: "manage join requests",
      pageErrors,
      pageMessages
    });
  }

  manageRequests_POST(team) {

    // We use a safe loop function in this method - quiet, jshint:

    team.populateUserInfo(this.req.user);

    if (!team.userIsModerator)
      return this.renderPermissionError();

    // We keep track of whether we've done any work, so we can show an
    // approrpriate message, and know whether we have to run saveAll()
    let workToBeDone = false;

    for (let key in this.req.body) {

      // Does it look like a request to perform an action?
      if (/^action-.+$/.test(key)) {

        // Safely extract the provided ID
        let id = (key.match(/action-(.*)$/) || [])[1];

        // Check if we do in fact have a join request that matches the action ID
        let requestIndex, requestObj;
        team.joinRequests.forEach((request, index) => {
          if (request.id == id) {
            requestObj = request;
            requestIndex = index;
          }
        });

        // If we do, perform the appropriate wrok
        if (requestObj) {
          switch (this.req.body[key]) {
            case 'reject':
              {
                team.joinRequests[requestIndex].rejectionDate = new Date();
                team.joinRequests[requestIndex].rejectedBy = this.req.user.id;
                let reason = this.req.body[`reject-reason-${id}`];
                if (reason)
                  team.joinRequests[requestIndex].rejectionMessage = escapeHTML(reason);
                workToBeDone = true;
                break;
              }
            case 'accept':
              team.members.push(team.joinRequests[requestIndex].user);
              team.joinRequests.splice(requestIndex, 1);
              workToBeDone = true;
              break;
              // no default
          }

        }

      }

    }
    if (workToBeDone) {
      team
        .saveAll()
        .then(() => {
          this.req.flash('pageMessages', this.req.__('requests have been processed'));
          this.res.redirect(`/team/${team.urlID}/manage-requests`);
        })
        .catch(this.next);
    } else {
      this.req.flash('pageErrors', this.req.__('no requests to process'));
      this.res.redirect(`/team/${team.urlID}/manage-requests`);
    }


  }

  // For incomplete submissions, pass formValues so form can be pre-populated.
  add_GET(formValues) {

    let pageErrors = this.req.flash('pageErrors');
    this.renderTemplate('team-form', {
      titleKey: this.actions[this.action].titleKey,
      pageErrors: this.isPreview ? undefined : pageErrors,
      formValues,
      isPreview: this.isPreview,
      scripts: ['editor']
    }, {
      messages: getEditorMessages(this.req.locale)
    });
  }


  loadData() {
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id);
  }

  // We just show a single review on the team entry page
  loadDataWithMostRecentReview() {

    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withReviews: true
    });

  }

  // This is for feed or feed/before/<date> requests
  loadDataWithFeed() {

    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withReviews: true,
      reviewLimit: 10,
      reviewOffsetDate: this.offsetDate || null
    });

  }

  loadDataWithJoinRequestDetails() {

    return slugs.resolveAndLoadTeam(this.req, this.res, this.id, {
      withJoinRequestDetails: true
    });

  }

  edit_GET(team) {

    this.add_GET(team);

  }

  async read_GET(team) {

    team.populateUserInfo(this.req.user);
    if (Array.isArray(team.reviews))
      team.reviews.forEach(review => review.populateUserInfo(this.req.user));

    let titleParam = mlString.resolve(this.req.locale, team.name).str;

    // Error messages from any join attempts
    let joinErrors = this.req.flash('joinErrors');

    if (this.req.user && !team.userIsModerator && !team.userIsMember)
      team.joinRequests.forEach(request => {
        if (request.userID === this.req.user.id) {
          if (!request.rejectionDate)
            this.req.flash('pageMessages', this.req.__('application received'));
          else
          if (request.rejectionMessage)
            this.req.flash('pageMessages',
              this.req.__('application rejected with reason', request.rejectionDate, request.rejectionMessage));
          else
            this.req.flash('pageMessages', this.req.__('application rejected', request.rejectionDate));
        }
      });

    if (team.userIsModerator) {
      let joinRequestCount = team.joinRequests.filter(request => !request.rejectionDate).length;
      let url = `/team/${team.urlID}/manage-requests`;
      if (joinRequestCount == 1)
        this.req.flash('pageMessages', this.req.__('pending join request', url));
      else if (joinRequestCount > 1)
        this.req.flash('pageMessages', this.req.__('pending join requests', url, joinRequestCount));
    }

    // Used for "welcome to the team" messages
    let pageMessages = this.req.flash('pageMessages');


    // For easy lookup in template
    let founder = {
      [team.createdBy]: true
    };

    const BlogPost = await getPostgresBlogPostModel();
    BlogPost.getMostRecentBlogPosts(team.id, {
        limit: 3
      })
      .then(result => {

        let blogPosts = result.blogPosts;
        let offsetDate = result.offsetDate;

        blogPosts.forEach(post => post.populateUserInfo(this.req.user));

        let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
          atomURLPrefix: `/team/${team.urlID}/blog/atom`,
          atomURLTitleKey: 'atom feed of blog posts by team'
        });

        embeddedFeeds = embeddedFeeds.concat(feeds.getEmbeddedFeeds(this.req, {
          atomURLPrefix: `/team/${team.urlID}/feed/atom`,
          atomURLTitleKey: 'atom feed of reviews by team'
        }));

        let paginationURL;
        if (team.reviewOffsetDate)
          paginationURL = `/team/${team.urlID}/feed/before/${team.reviewOffsetDate.toISOString()}`;

        this.renderTemplate('team', {
          team,
          titleKey: 'team title',
          titleParam,
          blogPosts,
          joinErrors,
          pageMessages,
          founder,
          embeddedFeeds,
          paginationURL,
          blogPostsUTCISODate: offsetDate ? offsetDate.toISOString() : undefined,
          deferPageHeader: true // Two-column-layout
        });

      });

  }

  feed_GET(team) {
    team.populateUserInfo(this.req.user);
    if (!Array.isArray(team.reviews))
      team.reviews = [];

    // For machine-readable feeds
    if (this.format && this.language)
      i18n.setLocale(this.req, this.language);

    let updatedDate;
    team.reviews.forEach(review => {
      review.populateUserInfo(this.req.user);
      if (review.thing)
        review.thing.populateUserInfo(this.req.user);
      // For Atom feed - most recently modified item in the result set
      if (!updatedDate || review._revDate > updatedDate)
        updatedDate = review._revDate;
    });

    let titleParam = mlString.resolve(this.req.locale, team.name).str;

    // Atom feed metadata for <link> tags in HTML version
    let atomURLPrefix = `/team/${team.urlID}/feed/atom`;
    let embeddedFeeds = feeds.getEmbeddedFeeds(this.req, {
      atomURLPrefix,
      atomURLTitleKey: 'atom feed of reviews by team'
    });

    let paginationURL;
    if (team.reviewOffsetDate)
      paginationURL = `/team/${team.urlID}/feed/before/${team.reviewOffsetDate.toISOString()}`;

    let vars = {
      team,
      teamURL: `/team/${team.urlID}`,
      feedItems: team.reviews,
      titleKey: 'team feed',
      titleParam,
      embeddedFeeds,
      deferPageHeader: true, // embedded link
      paginationURL
    };

    if (this.format) {
      if (this.format == 'atom') {

        Object.assign(vars, {
          layout: 'layout-atom',
          language: this.language,
          updatedDate,
          selfURL: url.resolve(config.qualifiedURL, `${atomURLPrefix}/${this.language}`),
          htmlURL: url.resolve(config.qualifiedURL, `/team/${team.urlID}/feed`)
        });
        this.res.type('application/atom+xml');
        this.renderTemplate('review-feed-atom', vars);
      } else {
        this.next(new Error(`Format ${this.format} not supported`));
      }
    } else {
      this.renderTemplate('team-feed', vars);
    }
  }

  edit_POST(team) {

    let formKey = 'edit-team';
    let language = this.req.body['team-language'];
    let formData = this.parseForm({
      formDef: TeamProvider.formDefs[formKey],
      formKey,
      language
    });

    this.isPreview = this.req.body['team-action'] == 'preview' ? true : false;

    if (this.req.flashHas('pageErrors') || this.isPreview)
      return this.edit_GET(formData.formValues);

    team
      .newRevision(this.req.user, {
        tags: ['edit-via-form']
      })
      .then(newRev => {

        let f = formData.formValues;
        newRev.motto[language] = f.motto[language];
        newRev.name[language] = f.name[language];
        newRev.description.text[language] = f.description.text[language];
        newRev.description.html[language] = f.description.html[language];
        newRev.rules.text[language] = f.rules.text[language];
        newRev.rules.html[language] = f.rules.html[language];
        newRev.onlyModsCanBlog = f.onlyModsCanBlog;
        newRev.modApprovalToJoin = f.modApprovalToJoin;

        newRev
          .updateSlug(this.req.user.id, language)
          .then(updatedRev => {
            updatedRev
              .save()
              .then(savedRev => this.res.redirect(`/team/${savedRev.urlID}`))
              .catch(this.next);
          })
          // Slug update failed
          .catch(error => {
            if (error.name === 'DuplicateSlugNameError') {
              this.req.flash('pageErrors', this.req.__('duplicate team name', `/team/${error.payload.slug.name}`));
              return this.edit_GET(formData.formValues);
            } else
              return this.next(error);
          });
      })
      .catch(this.next); // Creating new revision failed

  }

  add_POST() {

    let formKey = 'new-team';
    let formData = this.parseForm({
      formDef: TeamProvider.formDefs[formKey],
      formKey,
      language: this.req.body['team-language']
    });

    this.isPreview = this.req.body['team-action'] == 'preview' ? true : false;

    if (this.req.flashHas('pageErrors') || this.isPreview)
      return this.add_GET(formData.formValues);

    Team
      .createFirstRevision(this.req.user, {
        tags: ['create-via-form']
      })
      .then(team => {

        // Associate parsed form data with revision
        Object.assign(team, formData.formValues);

        // Creator is first moderator
        team.moderators = [this.req.user];

        // Creator is first member
        team.members = [this.req.user];

        // Founder warrants special recognition
        team.createdBy = this.req.user.id;
        team.createdOn = new Date();

        team
          .updateSlug(this.req.user.id, team.originalLanguage)
          .then(team => {
            team
              .saveAll()
              .then(team => this.res.redirect(`/team/${team.urlID}`))
              // Problem saving team and/or updating user
              .catch(this.next);
          })
          // Problem updating slug
          .catch(error => {
            if (error.name === 'DuplicateSlugNameError') {
              this.req.flash('pageErrors', this.req.__('duplicate team name', `/team/${error.payload.slug.name}`));
              return this.add_GET(formData.formValues);
            } else
              return this.next(error);
          });
      })
      // Problem getting metadata for new revision
      .catch(this.next);
  }

  delete_GET(team) {

    let pageErrors = this.req.flash('pageErrors');
    this.renderTemplate('team', {
      team,
      titleKey: this.actions[this.action].titleKey,
      deferPageHeader: true,
      pageErrors,
      deleteForm: true
    });

  }

  delete_POST(team) {
    team
      .deleteAllRevisions(this.req.user, {
        tags: ['delete-via-form']
      })
      .then(() => {
        this.renderTemplate('team-deleted', {
          titleKey: 'team deleted'
        });
      })
      .catch(this.next);
  }

}

// Shared by all instances
TeamProvider.formDefs = {
  'new-team': [{
    name: 'team-name',
    required: true,
    type: 'text',
    key: 'name'
  }, {
    name: 'team-motto',
    required: true,
    type: 'text',
    key: 'motto'
  }, {
    name: 'team-description',
    required: true,
    type: 'markdown',
    key: 'description'
  }, {
    name: 'team-rules',
    required: false,
    type: 'markdown',
    key: 'rules'
  }, {
    name: 'team-mod-approval-to-join',
    required: false,
    type: 'boolean',
    key: 'modApprovalToJoin'
  }, {
    name: 'team-only-mods-can-blog',
    required: false,
    type: 'boolean',
    key: 'onlyModsCanBlog'
  }, {
    name: 'team-language',
    required: true,
    key: 'originalLanguage'
  }, {
    name: 'team-action',
    required: true,
    skipValue: true // Only logic, not saved
  }],
};

TeamProvider.formDefs['edit-team'] = TeamProvider.formDefs['new-team'];

module.exports = TeamProvider;
