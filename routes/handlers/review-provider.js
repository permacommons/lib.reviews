'use strict';
// External dependencies
const config = require('config');

// Internal dependencies
const Review = require('../../models-postgres/review');
const Team = require('../../models-postgres/team');
const User = require('../../models-postgres/user');
const File = require('../../models-postgres/file');
const AbstractBREADProvider = require('./abstract-bread-provider');
const mlString = require('../../dal/lib/ml-string.js');
const urlUtils = require('../../util/url-utils');
const ReportedError = require('../../util/reported-error.js');
const md = require('../../util/md');
const slugs = require('../helpers/slugs');
const search = require('../../search');
const getMessages = require('../../util/get-messages');
const { getAdapterMessageKeys, getEditorMessageKeys } = require('../../util/frontend-messages');

class ReviewProvider extends AbstractBREADProvider {

  constructor(req, res, next, options) {

    super(req, res, next, options);
    this.actions.add.titleKey = 'new review';
    this.actions.edit.titleKey = 'edit review';
    this.actions.delete.titleKey = 'delete review';
    this.messageKeyPrefix = 'review';

    this.actions.addFromThing = {
      GET: this.addFromThing_GET,
      POST: this.add_POST,
      loadData: this.loadThing,
      titleKey: 'new review',
      preFlightChecks: [this.userIsSignedIn]
    };

    this.actions.addFromTeam = {
      GET: this.addFromTeam_GET,
      POST: this.addFromTeam_POST,
      loadData: this.loadTeam,
      titleKey: 'new review',
      preFlightChecks: [this.userIsSignedIn]
    };


  }

  read_GET(review) {

    let titleParam;
    if (review.thing) {
      if (review.thing.label)
        titleParam = mlString.resolve(this.req.locale, review.thing.label).str;
      else
        titleParam = urlUtils.prettify(review.thing.urls[0]);
    }

    // No permission checks on reads, so we have to do this manually
    review.populateUserInfo(this.req.user);

    let pageMessages = this.req.flash('pageMessages');

    this.renderTemplate('review', {
      titleKey: titleParam ? 'review of' : 'review',
      titleParam,
      deferPageHeader: true,
      socialImage: review.socialImage ? encodeURIComponent(review.socialImage.name) : review.headerImage,
      review,
      pageMessages
    });

  }

  async add_GET(formValues, thing) {
    let pageErrors = this.req.flash('pageErrors');
    let pageMessages = this.req.flash('pageMessages');
    let user = this.req.user;
    let showLanguageNotice = true;

    // Load user's teams for the form
    if (user && user.id) {
      try {
        const userWithTeams = await User.findByURLName(user.urlName, { withTeams: true });
        user.teams = userWithTeams.teams;
        user.moderatorOf = userWithTeams.moderatorOf;
      } catch (error) {
        // If we can't load teams, continue without them
        console.error('Failed to load user teams for review form:', error);
      }
    }

    // For easier processing in the template
    if (formValues) {
      if (formValues.starRating)
        formValues.hasRating = {
          [formValues.starRating]: true
        };
      formValues.hasTeam = {};
      if (Array.isArray(formValues.teams))
        formValues.teams.forEach(team => (formValues.hasTeam[team.id] = true));
        if (formValues.socialImageID)
          formValues.hasSocialImageID = {
            [formValues.socialImageID]: true
          };
      if (thing && thing.files)
        formValues.uploads = thing.files;
    }

    if (user.suppressedNotices &&
      user.suppressedNotices.indexOf('language-notice-review') !== -1)
      showLanguageNotice = false;

    this.renderTemplate('review-form', {
      formValues,
      titleKey: this.actions[this.action].titleKey,
      pageErrors: !this.isPreview ? pageErrors : undefined, // Don't show errors on preview
      isPreview: this.isPreview,
      preview: this.preview,
      scripts: ['review', 'editor'],
      showLanguageNotice,
      pageMessages,
      thing,
      editing: this.editing ? true : false
    }, {
      editing: this.editing ? true : false,
      messages: getMessages(this.req.locale,
        md.getMarkdownMessageKeys(),
        getEditorMessageKeys(),
        getAdapterMessageKeys(), ['more info', 'not a url', 'add http', 'add https']
      )
    });
  }

  async addFromThing_GET(thing) {

    try {
      const reviews = await thing.getReviewsByUser(this.req.user);
      if (reviews.length) {
        this.req.flash('pageMessages', this.req.__('you already wrote a review'));
        return this.res.redirect(`/review/${reviews[0].id}/edit`);
      }
      await this.add_GET(undefined, thing);
    } catch (error) {
      this.next(error);
    }

  }

  async addFromTeam_GET(team) {

    team.populateUserInfo(this.req.user);
    if (!team.userIsMember) {
      this.res.status(403);
      this.renderResourceError({
        titleKey: 'not a member of team title',
        bodyKey: 'not a member of team',
        bodyParam: `/team/${team.urlID}`
      });
    } else {
      let formValues = {
        teams: [team]
      };
      return await this.add_GET(formValues);
    }

  }

  addFromTeam_POST(_team) {

    // Standard submission has checks against submitting from team you're not
    // a member of, so we don't have to check again here. The loaded team itself
    // will be passed along through the form, so we don't need to pass it here.
    return this.add_POST();

  }

  add_POST(thing) {

    this.isPreview = this.req.body['review-action'] == 'preview' ? true : false;

    let formKey = 'new-review';
    let language = this.req.body['review-language'];
    let formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language,
      // We don't need a URL if we're adding a review to an existing thing
      skipRequiredCheck: thing && thing.id ? ['review-url'] : []
    });

    formData.formValues.createdBy = this.req.user.id;
    formData.formValues.createdOn = new Date();
    formData.formValues.originalLanguage = language;

    // Files uploaded from the editor
    formData.formValues.files = typeof formData.formValues.files == 'object' ?
      Object.keys(formData.formValues.files) : [];

    this
      .resolveTeamData(formData.formValues)
      .then(() => File.getMultipleNotStaleOrDeleted(formData.formValues.files))
      .then(async (uploadedFiles) => {
        const reviewObj = Object.assign({}, formData.formValues);

        // Pass existing and newly uploaded forms on to the form, so they
        // can both be selected. (This does not need to be included with the
        // review object that will be created.)
        formData.formValues.uploads = thing && thing.files ? uploadedFiles.concat(thing.files) :
          uploadedFiles;

        if (thing && thing.id)
          reviewObj.thing = thing;

        // We're previewing or have basic problems with the submission -- back to form
        if (this.isPreview || this.req.flashHas('pageErrors')) {
          formData.formValues.creator = this.req.user; // Needed for username link
          return await this.add_GET(formData.formValues, thing);
        }

        Review
          .create(reviewObj, {
            tags: ['create-via-form'],
            files: formData.formValues.files
          })
          .then(review => {
            this.req.app.locals.webHooks.trigger('newReview', {
              event: 'new-review',
              data: this.getWebHookData(review, this.req.user)
            });

            User
              .increaseInviteLinkCount(this.req.user.id)
              .then(() => {
                this.res.redirect(`/${review.thing.id}#your-review`);
                search.indexReview(review);
                search.indexThing(review.thing);
              })
              .catch(this.next); // Problem updating invite count
          })
          .catch(async (error) => {
            this.req.flashError(error);
            await this.add_GET(formData.formValues, thing);
          });

      })
      .catch(async (error) => {
        this.req.flashError(error);
        await this.add_GET(formData.formValues, thing);
      });

  }

  async loadData() {
    const review = await Review.getWithData(this.id);
    // For permission checks on associated thing
    review.thing.populateUserInfo(this.req.user);
    return review;
  }

  loadThing() {

    // Ensure we show "thing not found" error if user tries to create
    // review from a nonexistent/stale/deleted thing
    this.messageKeyPrefix = 'thing';
    return slugs.resolveAndLoadThing(this.req, this.res, this.id);

  }

  loadTeam() {
    this.messageKeyPrefix = 'team';
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id);
  }


  async edit_GET(review) {

    this.editing = true;
    await this.add_GET(review, review.thing);

  }

  edit_POST(review) {

    let formKey = 'edit-review';
    let language = this.req.body['review-language'];
    let formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language
    });

    // We no longer accept URL edits if we're in edit-mode
    this.editing = true;

    if (this.req.body['review-action'] == 'preview') {
      // Pass along original authorship info for preview
      formData.formValues.createdOn = review.createdOn;
      formData.formValues.creator = review.creator;
      this.isPreview = true;
    }

    formData.formValues.files = typeof formData.formValues.files == 'object' ?
      Object.keys(formData.formValues.files) : [];

    const abort = async (error) => {
      if (error)
        this.req.flashError(error);
      await this.add_GET(formData.formValues);
    };

    this
      .resolveTeamData(formData.formValues)
      .then(() => File.getMultipleNotStaleOrDeleted(formData.formValues.files))
      .then(uploadedFiles => {

        formData.formValues.uploads = review.thing.files ? uploadedFiles.concat(review.thing.files) :
          uploadedFiles;

        // As with creation, back to edit form if we have errors or
        // are previewing
        if (this.isPreview || this.req.flashHas('pageErrors'))
          return abort();

        // Save the edit
        review
          .newRevision(this.req.user, {
            tags: ['edit-via-form']
          })
          .then(async newRev => {
            let f = formData.formValues;

            Review.validateSocialImage({
              socialImageID: f.socialImageID,
              newFileIDs: f.files,
              fileObjects: review.thing.files
            });

            newRev.title[language] = f.title[language];
            newRev.text[language] = f.text[language];
            newRev.html[language] = f.html[language];
            newRev.starRating = f.starRating;
            newRev.teams = f.teams;
            newRev.thing = review.thing;
            newRev.socialImageID = f.socialImageID;
            this.saveNewRevisionAndFiles(newRev, f.files)
              .then(() => {
                search.indexReview(review);
                search.indexThing(review.thing);
                this.req.flash('pageMessages', this.req.__('edit saved'));
                this.res.redirect(`/review/${newRev.id}`);
              })
              .catch(abort);
          })
          .catch(abort);
      })
      .catch(abort);
  }

  // Save an edited review, and associate any newly uploaded files with the
  // review subject
  async saveNewRevisionAndFiles(newRev, files) {
    await newRev.saveAll({
      teams: true,
      thing: true
    });
    
    if (Array.isArray(files) && typeof newRev.thing == 'object')
      await newRev.thing.addFilesByIDsAndSave(files, newRev.createdBy);
  }

  // Obtain the data for each team submitted in the form and assign it to
  // formValues.
  async resolveTeamData(formValues) {
    if (typeof formValues.teams !== 'object' ||
      !Object.keys(formValues.teams).length) {
      formValues.teams = [];
      return;
    }

    const TeamModel = require('../../models-postgres/team');
    const queries = Object.keys(formValues.teams).map(teamId => TeamModel.getWithData(teamId));

    try {
      formValues.teams = await Promise.all(queries);
    } catch (error) {
      if (error.name == 'DocumentNotFound' || error.name == 'DocumentNotFoundError' || error.name == 'RevisionDeletedError')
        throw new ReportedError({
          parentError: error,
          userMessage: 'submitted team could not be found'
        });
      else
        throw error;
    }

    if (Array.isArray(formValues.teams)) {
      formValues.teams.forEach(team => {
        team.populateUserInfo(this.req.user);
        if (!team.userIsMember)
          throw new ReportedError({
            userMessage: 'user is not member of submitted team'
          });
      });
    }
  }

  delete_GET(review) {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate('delete-review', {
      review,
      pageErrors
    });
  }

  delete_POST(review) {
    let withThing = this.req.body['delete-thing'] ? true : false;
    this.parseForm({
      formDef: ReviewProvider.formDefs['delete-review'],
      formKey: 'delete-review'
    });

    // Trying to delete recursively, but can't!
    if (withThing && !review.thing.userCanDelete)
      return this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });

    if (this.req.flashHas('pageErrors'))
      return this.delete_GET(review);

    let deleteFunc = withThing ?
      review.deleteAllRevisionsWithThing :
      review.deleteAllRevisions;

    Reflect.apply(deleteFunc, review, [this.req.user])
      .then(() => {
        this.renderTemplate('review-deleted', {
          titleKey: 'review deleted'
        });
        search.deleteReview(review);
        if (withThing)
          search.deleteThing(review.thing);
      })
      .catch(this.next);
  }

  // Return data for easy external processing after publication, e.g. via IRC
  // feeds
  getWebHookData(review, user) {

    return {
      title: review.title,
      thingURLs: review.thing.urls,
      thingLabel: review.thing.label,
      starRating: review.starRating,
      html: review.html,
      text: review.text,
      createdOn: review.createdOn,
      author: user.displayName,
      reviewURL: `${config.qualifiedURL}review/${review.id}`,
      thingURL: `${config.qualifiedURL}thing/${review.thing.id}`,
      authorURL: `${config.qualifiedURL}user/${user.urlName}`
    };

  }

}

module.exports = ReviewProvider;


// Shared across instances
ReviewProvider.formDefs = {
  'new-review': [{
      name: 'review-url',
      required: true,
      type: 'url',
      key: 'url'
    }, {
      name: 'review-title',
      required: true,
      type: 'text',
      key: 'title'
    },
    {
      name: 'review-label',
      required: false,
      type: 'text',
      key: 'label'
    },
    {
      name: 'review-text',
      required: true,
      type: 'markdown',
      key: 'text',
      flat: true,
      htmlKey: 'html'
    }, {
      name: 'review-rating',
      required: true,
      type: 'number',
      key: 'starRating'
    }, {
      name: 'review-language',
      required: false,
      key: 'originalLanguage'
    }, {
      name: 'review-action',
      required: true,
      skipValue: true // Logic, not saved
    },
    {
      name: 'review-team-%uuid',
      required: false,
      type: 'boolean',
      keyValueMap: 'teams'
    },
    {
      name: 'review-social-image',
      type: 'uuid',
      key: 'socialImageID',
      required: false
    },
    {
      name: 'uploaded-file-%uuid',
      required: false,
      keyValueMap: 'files'
    },
  ],
  'delete-review': [{
    name: 'delete-action',
    required: true
  }, {
    name: 'delete-thing',
    required: false
  }],
  'edit-review': [{
      name: 'review-title',
      required: true,
      type: 'text',
      key: 'title'
    }, {
      name: 'review-text',
      required: true,
      type: 'markdown',
      key: 'text',
      flat: true,
      htmlKey: 'html'
    }, {
      name: 'review-rating',
      required: true,
      type: 'number',
      key: 'starRating'
    }, {
      name: 'review-language',
      required: true
    }, {
      name: 'review-action',
      required: true,
      skipValue: true
    },
    {
      name: 'review-team-%uuid',
      required: false,
      keyValueMap: 'teams'
    },
    {
      name: 'uploaded-file-%uuid',
      required: false,
      keyValueMap: 'files'
    },
    {
      name: 'review-social-image',
      type: 'uuid',
      key: 'socialImageID',
      required: false
    }
  ]
};
