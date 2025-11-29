// External dependencies
import config from 'config';
import escapeHTML from 'escape-html';
import { z } from 'zod';
import mlString, { type MultilingualString } from '../../dal/lib/ml-string.ts';
import languages from '../../locales/languages.ts';
import File, { type FileInstance } from '../../models/file.ts';
import {
  type ReviewInstance as ManifestReviewInstance,
  type ReviewInputObject,
  type ReviewValidateSocialImageOptions,
  reviewOptions,
} from '../../models/manifests/review.ts';
import type { TeamInstance as TeamManifestInstance } from '../../models/manifests/team.ts';
import type { ThingInstance } from '../../models/manifests/thing.ts';
import Review from '../../models/review.ts';
import Team from '../../models/team.ts';
import User from '../../models/user.ts';
import search from '../../search.ts';
// Internal dependencies
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import frontendMessages from '../../util/frontend-messages.ts';
import getMessages from '../../util/get-messages.ts';
import md, { getMarkdownMessageKeys } from '../../util/md.ts';
import ReportedError from '../../util/reported-error.ts';
import urlUtils from '../../util/url-utils.ts';
import slugs from '../helpers/slugs.ts';
import {
  flashZodIssues,
  formatZodIssueMessage,
  safeParseField,
  validateLanguage,
} from '../helpers/zod-flash.ts';
import {
  coerceString,
  createMultilingualMarkdownField,
  csrfField,
  csrfSchema,
  preprocessArrayField,
  requiredTrimmedString,
} from '../helpers/zod-forms.ts';
import AbstractBREADProvider from './abstract-bread-provider.ts';

type ReviewFormValues = {
  // From form parsing
  url?: string;
  title?: MultilingualString;
  label?: MultilingualString;
  text?: MultilingualString;
  html?: MultilingualString;
  starRating?: number;
  originalLanguage?: string;
  teams?: string[] | TeamInstance[]; // UUIDs from form, resolved to TeamInstance[] by resolveTeamData()
  socialImageID?: string;
  files?: string[];

  // Set programmatically for creation/persistence
  createdBy?: string;
  createdOn?: Date;
  thing?: ThingInstance;

  // Template helpers (for view rendering)
  hasRating?: Record<number, boolean>;
  hasTeam?: Record<string, boolean>;
  hasSocialImageID?: Record<string, boolean>;
  uploads?: Array<Record<string, unknown>>;
  creator?: unknown;
};

// Use manifest type for actual review instances loaded from DB
type ReviewInstance = ManifestReviewInstance;

type TeamInstance = TeamManifestInstance & Record<string, unknown>;
type ReviewSchemaResult = ReturnType<typeof buildReviewSchema>;
type ReviewFormSchema = ReviewSchemaResult['schema'];
type ParsedReviewForm = z.infer<ReviewFormSchema>;

const sanitizeText = (value: string) => escapeHTML(value.trim());
const normalizeURL = (value: unknown) => urlUtils.normalize(String(value ?? '').trim());
const normalizeReviewBody = (body: Record<string, unknown>) => ({
  ...body,
  teams: body.teams ?? body['teams[]'],
  files: body.files ?? body['files[]'],
});
const toIDString = (value: unknown) => coerceString(value).trim();

const buildReviewSchema = (
  req: HandlerRequest,
  language: string,
  options: { requireURL: boolean; requireLanguage: boolean; renderLocale?: string }
) => {
  const { requireURL, requireLanguage, renderLocale } = options;

  const urlField = z
    .preprocess(value => coerceString(value), z.string().trim().min(1, req.__('need review-url')))
    .transform(value => normalizeURL(value))
    .superRefine((value, ctx) => {
      if (!urlUtils.validate(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: req.__('not a url'),
        });
      }
    });

  const optionalURLField = z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    urlField.optional()
  );

  const titleField = z
    .preprocess(
      value => coerceString(value),
      z
        .string()
        .trim()
        .min(1, req.__('need review-title'))
        .max(reviewOptions.maxTitleLength, req.__('review title too long'))
    )
    .transform(value => ({ [language]: sanitizeText(value) }) as MultilingualString);

  const labelField = z.preprocess(
    value => (value === undefined || value === null ? undefined : String(value)),
    z
      .string()
      .trim()
      .transform(value => ({ [language]: sanitizeText(value) }) as MultilingualString)
      .optional()
  );

  const reviewTextField = z
    .preprocess(value => coerceString(value), z.string().trim().min(1, req.__('need review-text')))
    .pipe(createMultilingualMarkdownField(language, renderLocale));

  const starRatingField = z
    .preprocess(
      value => coerceString(value),
      z.string().trim().min(1, req.__('need review-rating'))
    )
    .transform((value, ctx) => {
      const numeric = Number(value);
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: req.__('invalid star rating', value),
        });
        return 0;
      }
      return numeric;
    });

  const languageFieldBase = z
    .string()
    .trim()
    .superRefine((value, ctx) => {
      try {
        languages.validate(value);
      } catch (_error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: req.__('invalid language code', value),
        });
      }
    });
  const languageField = requireLanguage
    ? languageFieldBase
    : z.preprocess(
        value =>
          value === undefined || value === null || String(value).trim() === '' ? undefined : value,
        languageFieldBase.optional()
      );

  const reviewActionField = z.enum(['publish', 'preview']);

  // Accept either raw IDs or { id } objects so previews/error re-renders keep selections intact
  // and keep the template-facing shape predictable.
  const idEntry = z.union([z.string(), z.object({ id: z.string() })]);
  const teamsField = z
    .preprocess(preprocessArrayField, z.array(idEntry))
    .transform(values =>
      values
        .map(entry =>
          typeof entry === 'string' ? coerceString(entry).trim() : toIDString(entry.id)
        )
        .filter(id => id.length)
    );

  const filesField = z
    .preprocess(preprocessArrayField, z.array(idEntry))
    .transform(values =>
      values
        .map(entry =>
          typeof entry === 'string' ? coerceString(entry).trim() : toIDString(entry.id)
        )
        .filter(id => id.length)
    );

  const socialImageField = z.preprocess(
    value =>
      value === undefined || value === null || String(value).trim() === '' ? undefined : value,
    z.string().uuid().optional()
  );

  const schema = z
    .object({
      _csrf: csrfField,
      'review-url': requireURL ? urlField : optionalURLField,
      'review-title': titleField,
      'review-label': labelField,
      'review-text': reviewTextField,
      'review-rating': starRatingField,
      'review-language': languageField,
      'review-action': reviewActionField,
      teams: teamsField,
      files: filesField,
      'review-social-image': socialImageField,
    })
    .strict();

  return {
    schema,
    fields: {
      url: requireURL ? urlField : optionalURLField,
      title: titleField,
      label: labelField,
      text: reviewTextField,
      starRating: starRatingField,
      language: languageField,
      reviewAction: reviewActionField,
      teams: teamsField,
      files: filesField,
      socialImageID: socialImageField,
    },
  };
};

const buildDeleteReviewSchema = (req: HandlerRequest) => {
  return csrfSchema.extend({
    'delete-action': z.string().min(1, req.__('need delete-action')),
    'delete-thing': z.preprocess(
      value => value !== undefined && value !== false,
      z.boolean().default(false)
    ),
  });
};

const toReviewFormValues = (data: ParsedReviewForm, fallbackLanguage: string): ReviewFormValues => {
  const values: ReviewFormValues = {
    title: data['review-title'],
    text: data['review-text'].text,
    html: data['review-text'].html,
    starRating: data['review-rating'],
    originalLanguage: data['review-language'] ?? fallbackLanguage,
    teams: data.teams,
    files: data.files ?? [],
  };

  if (data['review-url']) values.url = data['review-url'];
  if (data['review-label']) values.label = data['review-label'];
  if (data['review-social-image']) values.socialImageID = data['review-social-image'];
  if (typeof data['review-rating'] === 'number') values.starRating = data['review-rating'];

  return values;
};

const extractReviewFormValues = (
  fields: ReviewSchemaResult['fields'],
  body: Record<string, unknown>,
  fallbackLanguage: string
): ReviewFormValues => {
  const formValues: ReviewFormValues = {};

  const title = safeParseField<MultilingualString>(fields.title, body['review-title']);
  if (title) formValues.title = title;

  const label = safeParseField<MultilingualString | undefined>(fields.label, body['review-label']);
  if (label) formValues.label = label;

  const content = safeParseField<{ text: MultilingualString; html: MultilingualString }>(
    fields.text,
    body['review-text']
  );
  if (content) {
    formValues.text = content.text;
    formValues.html = content.html;
  }

  const url = safeParseField<string | undefined>(fields.url, body['review-url']);
  if (url) formValues.url = url;

  const starRating = safeParseField<number>(fields.starRating, body['review-rating']);
  if (typeof starRating === 'number') formValues.starRating = starRating;

  const language = safeParseField<string | undefined>(fields.language, body['review-language']);
  formValues.originalLanguage = language ?? fallbackLanguage;

  const teams = safeParseField<string[]>(fields.teams, body.teams);
  formValues.teams = teams ?? [];

  const files = safeParseField<string[]>(fields.files, body.files);
  formValues.files = files ?? [];

  const socialImageID = safeParseField<string | undefined>(
    fields.socialImageID,
    body['review-social-image']
  );
  if (socialImageID) formValues.socialImageID = socialImageID;

  return formValues;
};

class ReviewProvider extends AbstractBREADProvider {
  protected isPreview = false;
  protected editing = false;

  constructor(
    req: HandlerRequest,
    res: HandlerResponse,
    next: HandlerNext,
    options?: Record<string, unknown>
  ) {
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
      preFlightChecks: [this.userIsSignedIn],
    };

    this.actions.addFromTeam = {
      GET: this.addFromTeam_GET,
      POST: this.addFromTeam_POST,
      loadData: this.loadTeam,
      titleKey: 'new review',
      preFlightChecks: [this.userIsSignedIn],
    };
  }

  read_GET(review: ReviewInstance): void {
    let titleParam;
    if (review.thing) {
      if (review.thing.label)
        titleParam = mlString.resolve(this.req.locale, review.thing.label).str;
      else titleParam = urlUtils.prettify(review.thing.urls[0]);
    }

    // No permission checks on reads, so we have to do this manually
    review.populateUserInfo(this.req.user);

    let pageMessages = this.req.flash('pageMessages');

    this.renderTemplate('review', {
      titleKey: titleParam ? 'review of' : 'review',
      titleParam,
      deferPageHeader: true,
      socialImage: review.socialImage
        ? encodeURIComponent(review.socialImage.name)
        : review.headerImage,
      review,
      pageMessages,
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
          [formValues.starRating]: true,
        };
      // Zod may yield either normalized string IDs or TeamInstances (when preview/edit feeds back
      // saved data), so mark checkboxes for both shapes to keep selections sticky on re-render.
      const teamIDs = Array.isArray(formValues.teams)
        ? formValues.teams
            .map(entry =>
              typeof entry === 'string' ? entry : (entry as TeamInstance | undefined)?.id
            )
            .filter((id): id is string => Boolean(id))
        : [];
      const teamFlags = teamIDs.reduce<Record<string, boolean>>((acc, id) => {
        acc[id] = true;
        return acc;
      }, {});
      formValues.hasTeam = teamFlags;
      if (formValues.socialImageID)
        formValues.hasSocialImageID = {
          [formValues.socialImageID]: true,
        };
      if (thing && thing.files) formValues.uploads = thing.files;
    }

    if (user.suppressedNotices && user.suppressedNotices.indexOf('language-notice-review') !== -1)
      showLanguageNotice = false;

    this.renderTemplate(
      'review-form',
      {
        formValues,
        titleKey: this.actions[this.action].titleKey,
        pageErrors: !this.isPreview ? pageErrors : undefined, // Don't show errors on preview
        isPreview: this.isPreview,
        preview: this.preview,
        scripts: ['review', 'editor'],
        showLanguageNotice,
        pageMessages,
        thing,
        editing: !!this.editing,
      },
      {
        editing: !!this.editing,
        messages: getMessages(
          this.req.locale,
          getMarkdownMessageKeys(),
          frontendMessages.getEditorMessageKeys(),
          frontendMessages.getAdapterMessageKeys(),
          ['more info', 'not a url', 'add http', 'add https']
        ),
      }
    );
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
        bodyParam: `/team/${team.urlID}`,
      });
    } else {
      let formValues: ReviewFormValues = {
        teams: [team],
      };
      return await this.add_GET(formValues, undefined);
    }
  }

  addFromTeam_POST(_team: TeamInstance): Promise<void> {
    // Standard submission has checks against submitting from team you're not
    // a member of, so we don't have to check again here. The loaded team itself
    // will be passed along through the form, so we don't need to pass it here.
    return this.add_POST();
  }

  async add_POST(thing?: ThingInstance): Promise<void> {
    const languageValue = this.req.body?.['review-language'];
    const language =
      typeof languageValue === 'string' && languageValue.length ? languageValue : 'en';
    const reviewActionRaw =
      typeof this.req.body?.['review-action'] === 'string'
        ? (this.req.body['review-action'] as 'publish' | 'preview')
        : undefined;
    this.isPreview = reviewActionRaw === 'preview';
    const requireURL = !(thing && thing.id);

    validateLanguage(this.req, language);

    const { schema, fields } = buildReviewSchema(this.req, language, {
      requireURL,
      requireLanguage: false,
      renderLocale: this.req.locale,
    });
    const normalizedBody = normalizeReviewBody((this.req.body ?? {}) as Record<string, unknown>);
    const parseResult = schema.safeParse(normalizedBody);

    if (!parseResult.success) {
      flashZodIssues(this.req, parseResult.error.issues, issue =>
        formatZodIssueMessage(this.req, issue)
      );
      const fallbackValues = extractReviewFormValues(fields, normalizedBody, language);
      if (this.isPreview) {
        fallbackValues.creator = this.req.user;
        fallbackValues.createdOn = new Date();
      }
      if (!fallbackValues.url)
        fallbackValues.url = coerceString(normalizedBody['review-url']).trim();
      return this.add_GET(fallbackValues, thing);
    }

    const reviewAction = parseResult.data['review-action'];
    this.isPreview = reviewAction === 'preview';
    const formValues = toReviewFormValues(parseResult.data, language);

    if (typeof this.req.user?.id === 'string') formValues.createdBy = this.req.user.id;
    formValues.createdOn = new Date();

    this.resolveTeamData(formValues)
      .then(() => File.getMultipleNotStaleOrDeleted(formValues.files))
      .then(async (uploadedFiles: FileInstance[]) => {
        const reviewObj = Object.assign({}, formValues);

        // Pass existing and newly uploaded forms on to the form, so they
        // can both be selected. (This does not need to be included with the
        // review object that will be created.)
        formValues.uploads =
          thing && thing?.files ? uploadedFiles.concat(thing.files) : uploadedFiles;

        if (thing && thing.id) reviewObj.thing = thing;

        // We're previewing or have basic problems with the submission -- back to form
        if (this.isPreview || this.req.flashHas?.('pageErrors')) {
          formValues.creator = this.req.user; // Needed for username link
          return await this.add_GET(formValues, thing);
        }

        Review.create(reviewObj as ReviewInputObject, {
          tags: ['create-via-form'],
          files: formValues.files,
        })
          .then((review: ReviewInstance) => {
            this.req.app.locals.webHooks.trigger('newReview', {
              event: 'new-review',
              data: this.getWebHookData(review, this.req.user),
            });

            User.filterWhere({ id: this.req.user.id })
              .increment('inviteLinkCount', { by: 1 })
              .then(() => {
                this.res.redirect(`/${review.thing.id}#your-review`);
                search.indexReview(review);
                search.indexThing(review.thing);
              })
              .catch(this.next); // Problem updating invite count
          })
          .catch(async error => {
            this.req.flashError(error);
            await this.add_GET(formValues, thing);
          });
      })
      .catch(async error => {
        this.req.flashError(error);
        await this.add_GET(formValues, thing);
      });
  }

  async loadData(): Promise<ReviewInstance> {
    const review = await Review.getWithData(this.id);
    if (!review) {
      throw new Error(`Review ${this.id} not found`);
    }
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

  async edit_POST(review: ReviewInstance): Promise<void> {
    const languageValue = this.req.body?.['review-language'];
    const language =
      typeof languageValue === 'string' ? languageValue : (review.originalLanguage ?? 'en');
    const reviewActionRaw =
      typeof this.req.body?.['review-action'] === 'string'
        ? (this.req.body['review-action'] as 'publish' | 'preview')
        : undefined;
    this.isPreview = reviewActionRaw === 'preview';
    validateLanguage(this.req, language);
    const { schema, fields } = buildReviewSchema(this.req, language, {
      requireURL: false,
      requireLanguage: true,
      renderLocale: this.req.locale,
    });
    const normalizedBody = normalizeReviewBody((this.req.body ?? {}) as Record<string, unknown>);
    const parseResult = schema.safeParse(normalizedBody);

    if (!parseResult.success) {
      flashZodIssues(this.req, parseResult.error.issues, issue =>
        formatZodIssueMessage(this.req, issue)
      );
      const fallbackValues = extractReviewFormValues(fields, normalizedBody, language);
      if (this.isPreview) {
        fallbackValues.creator = review.creator;
        fallbackValues.createdOn = review.createdOn;
      }
      return this.add_GET(fallbackValues, review.thing);
    }

    const reviewAction = parseResult.data['review-action'];
    const formValues = toReviewFormValues(parseResult.data, language);

    // We no longer accept URL edits if we're in edit-mode
    this.editing = true;

    if (reviewAction === 'preview') {
      // Pass along original authorship info for preview
      formValues.createdOn = review.createdOn;
      formValues.creator = review.creator;
      this.isPreview = true;
    }

    if (!Array.isArray(formValues.files)) {
      formValues.files = [];
    }

    const abort = async (error?: unknown) => {
      if (error) this.req.flashError(error);
      await this.add_GET(formValues, review.thing);
    };

    this.resolveTeamData(formValues)
      .then(() => File.getMultipleNotStaleOrDeleted(formValues.files))
      .then((uploadedFiles: FileInstance[]) => {
        formValues.uploads = review.thing.files
          ? uploadedFiles.concat(review.thing.files)
          : uploadedFiles;

        // As with creation, back to edit form if we have errors or
        // are previewing
        if (this.isPreview || this.req.flashHas?.('pageErrors')) return abort();

        // Save the edit
        review
          .newRevision(this.req.user, {
            tags: ['edit-via-form'],
          })
          .then(async newRev => {
            const f = formValues;

            Review.validateSocialImage({
              socialImageID: f.socialImageID,
              newFileIDs: f.files,
              fileObjects: review.thing.files as ReviewValidateSocialImageOptions['fileObjects'],
            });

            const titleTranslations = newRev.title as MultilingualString;
            const textTranslations = newRev.text as MultilingualString;
            const htmlTranslations = newRev.html as MultilingualString;
            const formTitles = f.title ?? {};
            const formTexts = f.text ?? {};
            const formHtml = f.html ?? {};
            titleTranslations[language] = formTitles[language] ?? '';
            textTranslations[language] = formTexts[language] ?? '';
            htmlTranslations[language] = formHtml[language] ?? '';
            newRev.starRating = f.starRating;
            // After resolveTeamData(), teams is always TeamInstance[]
            newRev.teams = f.teams as TeamInstance[];
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
      thing: true,
    });

    if (Array.isArray(files) && typeof newRev.thing == 'object')
      await newRev.thing.addFilesByIDsAndSave(files, newRev.createdBy);
  }

  // Obtain the data for each team submitted in the form and assign it to
  // formValues.
  async resolveTeamData(formValues: ReviewFormValues): Promise<void> {
    if (!Array.isArray(formValues.teams) || !formValues.teams.length) {
      formValues.teams = [];
      return;
    }

    const queries = (formValues.teams as string[]).map(teamId => Team.getWithData(teamId));

    try {
      formValues.teams = await Promise.all(queries);
    } catch (error) {
      if (
        error.name == 'DocumentNotFound' ||
        error.name == 'DocumentNotFoundError' ||
        error.name == 'RevisionDeletedError'
      )
        throw new ReportedError({
          parentError: error,
          userMessage: 'submitted team could not be found',
        });
      else throw error;
    }

    if (Array.isArray(formValues.teams)) {
      formValues.teams.forEach(teamEntry => {
        const team = teamEntry as TeamInstance;
        team.populateUserInfo(this.req.user);
        if (!team.userIsMember)
          throw new ReportedError({
            userMessage: 'user is not member of submitted team',
          });
      });
    }
  }

  delete_GET(review: ReviewInstance): void {
    let pageErrors = this.req.flash('pageErrors');

    this.renderTemplate('delete-review', {
      review,
      pageErrors,
    });
  }

  delete_POST(review: ReviewInstance): void {
    const schema = buildDeleteReviewSchema(this.req);
    const parseResult = schema.safeParse(this.req.body);

    if (!parseResult.success) {
      flashZodIssues(this.req, parseResult.error.issues, issue =>
        formatZodIssueMessage(this.req, issue)
      );
      return this.delete_GET(review);
    }

    const { 'delete-thing': withThing } = parseResult.data;

    // Trying to delete recursively, but can't!
    if (withThing && !review.thing.userCanDelete)
      return this.renderPermissionError({
        titleKey: this.actions[this.action].titleKey,
      });

    const deleteFunc = withThing ? review.deleteAllRevisionsWithThing : review.deleteAllRevisions;

    Promise.resolve(deleteFunc.call(review, this.req.user))
      .then(() => {
        this.renderTemplate('review-deleted', {
          titleKey: 'review deleted',
        });
        search.deleteReview(review);
        if (withThing) search.deleteThing(review.thing);
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
      authorURL: `${config.qualifiedURL}user/${user.urlName}`,
    };
  }
}

export default ReviewProvider;
