// External dependencies
import config from 'config';

// Internal dependencies
import type { HandlerRequest, HandlerResponse, HandlerNext } from '../../types/http/handlers.ts';
import Review from '../../models/review.ts';
import Team from '../../models/team.ts';
import User from '../../models/user.ts';
import File from '../../models/file.ts';
import AbstractBREADProvider from './abstract-bread-provider.ts';
import mlString from '../../dal/lib/ml-string.ts';
import urlUtils from '../../util/url-utils.ts';
import ReportedError from '../../util/reported-error.ts';
import md, { getMarkdownMessageKeys } from '../../util/md.ts';
import slugs from '../helpers/slugs.ts';
import search from '../../search.ts';
import getMessages from '../../util/get-messages.ts';
import frontendMessages from '../../util/frontend-messages.ts';

const ReviewModel = Review as any;
const TeamModel = Team as any;
const UserModel = User as any;
const FileModel = File as any;

type ThingInstance = {
  id: string;
  label?: Record<string, string>;
  urls?: string[];
  files?: Array<Record<string, unknown>>;
  populateUserInfo: (user: HandlerRequest['user']) => void;
  addFilesByIDsAndSave?: (files: string[], userId: string) => Promise<unknown>;
  [key: string]: unknown;
};

type ReviewFormValues = {
  title?: Record<string, string>;
  text?: Record<string, string>;
  html?: Record<string, string>;
  starRating?: number;
  files?: string[];
  uploads?: Array<Record<string, unknown>>;
  teams?: Array<Record<string, unknown>>;
  socialImageID?: string;
  createdBy?: string;
  createdOn?: Date;
  creator?: unknown;
  thing?: ThingInstance;
  [key: string]: any;
};

type ReviewInstance = ReviewFormValues & {
  id: string;
  thing: ThingInstance;
  socialImage?: { name: string };
  headerImage?: string;
  populateUserInfo: (user: HandlerRequest['user']) => void;
  newRevision: (user: HandlerRequest['user'], options?: Record<string, unknown>) => Promise<ReviewInstance>;
  saveAll: (options: Record<string, unknown>) => Promise<unknown>;
  deleteAllRevisions: (user: HandlerRequest['user'], options?: Record<string, unknown>) => Promise<unknown>;
};

type TeamInstance = {
  id: string;
  urlID?: string;
  userIsMember?: boolean;
  populateUserInfo: (user: HandlerRequest['user']) => void;
  [key: string]: unknown;
};

class ReviewProvider extends AbstractBREADProvider {
  static formDefs: Record<string, any>;
  protected isPreview = false;
  protected editing = false;

  constructor(req: HandlerRequest, res: HandlerResponse, next: HandlerNext, options?: Record<string, unknown>) {

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

  read_GET(review: ReviewInstance): void {

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

  async add_GET(formValues?: ReviewFormValues, thing?: ThingInstance): Promise<void> {
    let pageErrors = this.req.flash('pageErrors');
    let pageMessages = this.req.flash('pageMessages');
    let user = this.req.user;
    let showLanguageNotice = true;

    // Load user's teams for the form
    if (user && user.id) {
      try {
        const userWithTeams = await UserModel.findByURLName(user.urlName, { withTeams: true });
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
      const teamFlags: Record<string, boolean> = {};
      if (Array.isArray(formValues.teams))
        formValues.teams.forEach(teamEntry => {
          const teamObj = teamEntry as TeamInstance;
          if (teamObj?.id)
            teamFlags[teamObj.id] = true;
        });
      formValues.hasTeam = teamFlags;
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
        getMarkdownMessageKeys(),
        frontendMessages.getEditorMessageKeys(),
        frontendMessages.getAdapterMessageKeys(), ['more info', 'not a url', 'add http', 'add https']
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

  async addFromTeam_GET(team: TeamInstance): Promise<void> {

    team.populateUserInfo(this.req.user);
    if (!team.userIsMember) {
      this.res.status(403);
      this.renderResourceError({
        titleKey: 'not a member of team title',
        bodyKey: 'not a member of team',
        bodyParam: `/team/${team.urlID}`
      });
    } else {
      let formValues: ReviewFormValues = {
        teams: [team]
      };
      return await this.add_GET(formValues, undefined);
    }

  }

  addFromTeam_POST(_team: TeamInstance): void {

    // Standard submission has checks against submitting from team you're not
    // a member of, so we don't have to check again here. The loaded team itself
    // will be passed along through the form, so we don't need to pass it here.
    return this.add_POST();

  }

  add_POST(thing?: ThingInstance): void {

    const reviewAction = this.req.body?.['review-action'];
    this.isPreview = reviewAction === 'preview';

    const formKey = 'new-review';
    const languageValue = this.req.body?.['review-language'];
    const language = typeof languageValue === 'string' ? languageValue : 'en';
    const formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language,
      // We don't need a URL if we're adding a review to an existing thing
      skipRequiredCheck: thing && thing.id ? ['review-url'] : []
    });

    const formValues = formData.formValues as ReviewFormValues;

    if (typeof this.req.user?.id === 'string')
      formValues.createdBy = this.req.user.id;
    formValues.createdOn = new Date();
    formValues.originalLanguage = language;

    // Files uploaded from the editor
    if (formValues.files && !Array.isArray(formValues.files) && typeof formValues.files === 'object')
      formValues.files = Object.keys(formValues.files);
    else if (!Array.isArray(formValues.files))
      formValues.files = [];

    this
      .resolveTeamData(formValues)
      .then(() => FileModel.getMultipleNotStaleOrDeleted(formValues.files))
      .then(async (uploadedFiles) => {
        const reviewObj = Object.assign({}, formValues);

        // Pass existing and newly uploaded forms on to the form, so they
        // can both be selected. (This does not need to be included with the
        // review object that will be created.)
        formValues.uploads = thing && thing?.files ? uploadedFiles.concat(thing.files) :
          uploadedFiles;

        if (thing && thing.id)
          reviewObj.thing = thing;

        // We're previewing or have basic problems with the submission -- back to form
        if (this.isPreview || this.req.flashHas?.('pageErrors')) {
          formValues.creator = this.req.user; // Needed for username link
          return await this.add_GET(formValues, thing);
        }

        ReviewModel
          .create(reviewObj, {
            tags: ['create-via-form'],
            files: formValues.files
          })
          .then(review => {
            this.req.app.locals.webHooks.trigger('newReview', {
              event: 'new-review',
              data: this.getWebHookData(review, this.req.user)
            });

            UserModel
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
            await this.add_GET(formValues, thing);
          });

      })
      .catch(async (error) => {
        this.req.flashError(error);
        await this.add_GET(formValues, thing);
      });

  }

  async loadData(): Promise<ReviewInstance> {
    const review = await ReviewModel.getWithData(this.id) as ReviewInstance;
    // For permission checks on associated thing
    review.thing.populateUserInfo(this.req.user);
    return review;
  }

  loadThing(): Promise<ThingInstance> {

    // Ensure we show "thing not found" error if user tries to create
    // review from a nonexistent/stale/deleted thing
    this.messageKeyPrefix = 'thing';
    return slugs.resolveAndLoadThing(this.req, this.res, this.id) as Promise<ThingInstance>;

  }

  loadTeam(): Promise<TeamInstance> {
    this.messageKeyPrefix = 'team';
    return slugs.resolveAndLoadTeam(this.req, this.res, this.id) as Promise<TeamInstance>;
  }


  async edit_GET(review: ReviewInstance): Promise<void> {

    this.editing = true;
    await this.add_GET(review, review.thing);

  }

  edit_POST(review: ReviewInstance): void {

    const formKey = 'edit-review';
    const languageValue = this.req.body?.['review-language'];
    const language = typeof languageValue === 'string' ? languageValue : review.originalLanguage ?? 'en';
    const formData = this.parseForm({
      formDef: ReviewProvider.formDefs[formKey],
      formKey,
      language
    });

    const formValues = formData.formValues as ReviewFormValues;

    // We no longer accept URL edits if we're in edit-mode
    this.editing = true;

    if (this.req.body?.['review-action'] === 'preview') {
      // Pass along original authorship info for preview
      formValues.createdOn = review.createdOn;
      formValues.creator = review.creator;
      this.isPreview = true;
    }

    if (formValues.files && !Array.isArray(formValues.files) && typeof formValues.files === 'object')
      formValues.files = Object.keys(formValues.files);
    else if (!Array.isArray(formValues.files))
      formValues.files = [];

    const abort = async (error?: unknown) => {
      if (error)
        this.req.flashError(error);
      await this.add_GET(formValues, review.thing);
    };

    this
      .resolveTeamData(formValues)
      .then(() => FileModel.getMultipleNotStaleOrDeleted(formValues.files))
      .then(uploadedFiles => {

        formValues.uploads = review.thing.files ? uploadedFiles.concat(review.thing.files) :
          uploadedFiles;

        // As with creation, back to edit form if we have errors or
        // are previewing
        if (this.isPreview || this.req.flashHas?.('pageErrors'))
          return abort();

        // Save the edit
        review
          .newRevision(this.req.user, {
            tags: ['edit-via-form']
          })
          .then(async newRev => {
            const f = formValues;

            ReviewModel.validateSocialImage({
              socialImageID: f.socialImageID,
              newFileIDs: f.files,
              fileObjects: review.thing.files
            });

            const titleTranslations = (newRev.title as Record<string, string>);
            const textTranslations = (newRev.text as Record<string, string>);
            const htmlTranslations = (newRev.html as Record<string, string>);
            const formTitles = f.title ?? {};
            const formTexts = f.text ?? {};
            const formHtml = f.html ?? {};
            titleTranslations[language] = formTitles[language] ?? '';
            textTranslations[language] = formTexts[language] ?? '';
            htmlTranslations[language] = formHtml[language] ?? '';
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
  async saveNewRevisionAndFiles(newRev: ReviewInstance, files: string[]): Promise<void> {
    await newRev.saveAll({
      teams: true,
      thing: true
    });

    if (Array.isArray(files) && typeof newRev.thing == 'object')
      await newRev.thing.addFilesByIDsAndSave(files, newRev.createdBy);
  }

  // Obtain the data for each team submitted in the form and assign it to
  // formValues.
  async resolveTeamData(formValues: ReviewFormValues): Promise<void> {
    if (typeof formValues.teams !== 'object' ||
      !Object.keys(formValues.teams).length) {
      formValues.teams = [];
      return;
    }

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
      formValues.teams.forEach(teamEntry => {
        const team = teamEntry as TeamInstance;
        team.populateUserInfo(this.req.user);
        if (!team.userIsMember)
          throw new ReportedError({
            userMessage: 'user is not member of submitted team'
          });
      });
    }
  }

  delete_GET(review: ReviewInstance): void {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate('delete-review', {
      review,
      pageErrors
    });
  }

  delete_POST(review: ReviewInstance): void {
    const withThing = Boolean(this.req.body?.['delete-thing']);
    this.parseForm({
      formDef: ReviewProvider.formDefs['delete-review'],
      formKey: 'delete-review'
    });

    // Trying to delete recursively, but can't!
    if (withThing && !review.thing.userCanDelete)
      return this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey
      });

    if (this.req.flashHas?.('pageErrors'))
      return this.delete_GET(review);

    const deleteFunc = withThing && typeof (review as any).deleteAllRevisionsWithThing === 'function'
      ? (review as any).deleteAllRevisionsWithThing
      : review.deleteAllRevisions;

    const deleteFn = deleteFunc as (this: ReviewInstance, user: HandlerRequest['user']) => Promise<unknown>;
    Promise.resolve(deleteFn.call(review, this.req.user))
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
  getWebHookData(review: ReviewInstance, user: HandlerRequest['user']) {

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

export default ReviewProvider;


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
