import * as url from 'node:url';
import config from 'config';
import escapeHTML from 'escape-html';
import { Router } from 'express';
import { z } from 'zod';
import type { MultilingualString } from 'rev-dal/lib/ml-string';
import languages from '../locales/languages.ts';
import {
  type ReviewFeedResult,
  type ReviewInstance,
  type ReviewModel,
} from '../models/manifests/review.ts';
import { type ThingInstance } from '../models/manifests/thing.ts';
import Review from '../models/review.ts';
import Thing from '../models/thing.ts';
import search from '../search.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import getMessages from '../util/get-messages.ts';
import urlUtils from '../util/url-utils.ts';
import getResourceErrorHandler from './handlers/resource-error-handler.ts';
import signinRequiredRoute from './handlers/signin-required-route.ts';
import feeds from './helpers/feeds.ts';
import render from './helpers/render.ts';
import slugs from './helpers/slugs.ts';
import {
  flashZodIssues,
  formatZodIssueMessage,
  safeParseField,
  validateLanguage,
} from './helpers/zod-flash.ts';
import { csrfField } from './helpers/zod-forms.ts';

const ReviewHandle = Review as ReviewModel;

type ThingSyncConfig = {
  description?: {
    active?: boolean;
  };
};

type ThingRouteRequest<Params extends Record<string, string> = Record<string, string>> =
  HandlerRequest<Params>;
type ThingRouteResponse = HandlerResponse;
interface ThingURLsFormParams {
  req: ThingRouteRequest<{ id: string }>;
  res: ThingRouteResponse;
  titleKey: string;
  thing: ThingInstance;
  formValues?: Partial<ThingURLsFormValues>;
}

const router = Router();

// For handling form fields
const editableFields = ['description', 'label'];

const buildThingEditSchema = (field: string) => {
  const fieldName = `thing-${field}`;

  return z.object({
    _csrf: csrfField,
    [fieldName]: z.string().transform(value => escapeHTML(value.trim())),
  });
};

const normalizeURLValue = (value: unknown) => urlUtils.normalize(String(value ?? '').trim());
const preprocessURLs = (value: unknown) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
};

const buildThingURLsSchema = (req: ThingRouteRequest) => {
  const primaryField = z
    .string()
    .trim()
    .min(1, req.__('need primary'))
    .transform(value => Number.parseInt(value, 10))
    .refine(value => !Number.isNaN(value), { message: req.__('need primary') });

  const urlsField = z.preprocess(
    value => preprocessURLs(value).map(normalizeURLValue),
    z.array(z.string())
  );

  const schema = z
    .object({
      _csrf: csrfField,
      primary: primaryField,
      urls: urlsField,
    })
    .strict();

  return {
    primaryField,
    urlsField,
    schema,
  };
};

type ThingURLsSchema = ReturnType<typeof buildThingURLsSchema>['schema'];
type ThingURLsFormData = z.infer<ThingURLsSchema>;
type ThingURLsFormValues = Pick<ThingURLsFormData, 'primary' | 'urls'>;

router.get(
  '/:id',
  (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(thing => loadThingAndReviews(req, res, next, thing))
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

router.get(
  '/:id/manage/urls',
  signinRequiredRoute(
    'manage links',
    (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse, next: HandlerNext) => {
      const { id } = req.params,
        titleKey = res.locals.titleKey;

      slugs
        .resolveAndLoadThing(req, res, id)
        .then(async thing => {
          thing.populateUserInfo(req.user);
          if (!thing.userCanEdit) return render.permissionError(req, res, { titleKey });

          sendThingURLsForm({ req, res, titleKey, thing });
        })
        .catch(getResourceErrorHandler(req, res, next, 'thing', id));
    }
  )
);

// Update the set of URLs associated with a given thing from user input. The
// first URL in the array is the "primary" URL, used wherever we want to
// offer a convenient single external link related to a review subject.
router.post(
  '/:id/manage/urls',
  signinRequiredRoute(
    'manage links',
    (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse, next: HandlerNext) => {
      const { id } = req.params,
        titleKey = res.locals.titleKey;

      slugs
        .resolveAndLoadThing(req, res, id)
        .then(async thing => {
          thing.populateUserInfo(req.user);
          if (!thing.userCanEdit) return render.permissionError(req, res, { titleKey });

          processThingURLsUpdate({ req, res, thing, titleKey });
        })
        .catch(getResourceErrorHandler(req, res, next, 'thing', id));
    }
  )
);

router.get(
  '/:id/edit/:field',
  (
    req: ThingRouteRequest<{ id: string; field: string }>,
    res: ThingRouteResponse,
    next: HandlerNext
  ) => {
    if (!editableFields.includes(req.params.field)) return next();

    const titleKey = `edit ${req.params.field}`;
    const edit = {
      [req.params.field]: true,
    };
    const { id } = req.params;

    if (!req.user) return render.signinRequired(req, res, { titleKey });

    slugs
      .resolveAndLoadThing(req, res, id)
      .then(async thing => {
        thing.populateUserInfo(req.user);
        if (!thing.userCanEdit) return render.permissionError(req, res, { titleKey });

        const syncConfig = (thing.sync ?? {}) as ThingSyncConfig;
        const descriptionSyncActive = Boolean(syncConfig.description?.active);
        if (req.params.field === 'description' && descriptionSyncActive)
          return render.permissionError(req, res, {
            titleKey,
            detailsKey: 'cannot edit synced field',
          });

        sendForm(req, res, thing, edit, titleKey);
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

router.post('/:id/edit/:field', processTextFieldUpdate);

router.get(
  '/:id/before/:utcisodate',
  (
    req: ThingRouteRequest<{ id: string; utcisodate: string }>,
    res: ThingRouteResponse,
    next: HandlerNext
  ) => {
    const { id } = req.params;
    let utcISODate = req.params.utcisodate;
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(thing => {
        let offsetDate = new Date(utcISODate);
        if (!offsetDate || Number.isNaN(offsetDate.getTime())) offsetDate = null;
        loadThingAndReviews(req, res, next, thing, offsetDate);
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

router.get(
  '/:id/atom/:language',
  (
    req: ThingRouteRequest<{ id: string; language: string }>,
    res: ThingRouteResponse,
    next: HandlerNext
  ) => {
    const { id } = req.params;
    let language = req.params.language;
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(async thing => {
        if (!languages.isValid(language)) return res.redirect(`/${id}/atom/en`);

        try {
          const result = await ReviewHandle.getFeed({
            thingID: thing.id,
            withThing: false,
            withTeams: true,
          });

          let updatedDate;
          result.feedItems.forEach(review => {
            if (!updatedDate || (review.createdOn && review.createdOn > updatedDate))
              updatedDate = review.createdOn;
          });

          const setLocale = (req as unknown as { setLocale?: (locale: string) => void }).setLocale;
          setLocale?.(language);
          res.type('application/atom+xml');
          render.template(req, res, 'thing-feed-atom', {
            titleKey: 'reviews of',
            thing,
            layout: 'layout-atom',
            language,
            updatedDate,
            feedItems: result.feedItems,
            selfURL: url.resolve(config.qualifiedURL, `/${id}/atom/${language}`),
            htmlURL: url.resolve(config.qualifiedURL, `/${id}`),
          });
        } catch (error) {
          next(error);
        }
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

router.get(
  '/:id/delete',
  (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(async thing => {
        const titleKey = 'delete thing';
        thing.populateUserInfo(req.user);
        if (!thing.userCanDelete) return render.permissionError(req, res, { titleKey });

        // Check if thing has associated reviews
        const reviewCount = await thing.getReviewCount();
        if (reviewCount > 0) {
          req.flash('pageErrors', req.__('cannot delete thing with reviews', String(reviewCount)));
          return res.redirect(`/${id}`);
        }

        // Compute same variables as main thing page
        const taggedURLs =
          Array.isArray(thing.urls) && thing.urls.length > 1
            ? urlUtils.getURLsByTag(thing.urls.slice(1), { onlyOneTag: true, sortResults: true })
            : {};

        render.template(req, res, 'delete-thing', {
          thing,
          titleKey,
          singleColumn: true,
          taggedURLs,
          hasMoreThanOneReview:
            typeof thing.numberOfReviews === 'number' ? thing.numberOfReviews > 1 : false,
          activeSourceIDs: thing.getSourceIDsOfActiveSyncs(),
        });
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

router.post(
  '/:id/delete',
  (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse, next: HandlerNext) => {
    const { id } = req.params;
    slugs
      .resolveAndLoadThing(req, res, id)
      .then(async thing => {
        const titleKey = 'thing deleted';
        thing.populateUserInfo(req.user);
        if (!thing.userCanDelete) return render.permissionError(req, res, { titleKey });

        // Check if thing has associated reviews
        const reviewCount = await thing.getReviewCount();
        if (reviewCount > 0) {
          req.flash('pageErrors', req.__('cannot delete thing with reviews', String(reviewCount)));
          return res.redirect(`/${id}`);
        }

        thing
          .deleteAllRevisions(req.user)
          .then(() => {
            search.deleteThing(thing);
            render.template(req, res, 'thing-deleted', {
              thing,
              titleKey,
            });
          })
          .catch(next);
      })
      .catch(getResourceErrorHandler(req, res, next, 'thing', id));
  }
);

// Legacy redirects

router.get('/thing/:id', (req: ThingRouteRequest<{ id: string }>, res: ThingRouteResponse) => {
  const { id } = req.params;
  return res.redirect(`/${id}`);
});

router.get(
  '/thing/:id/before/:utcisodate',
  (req: ThingRouteRequest<{ id: string; utcisodate: string }>, res: ThingRouteResponse) => {
    const { id } = req.params;
    let utcISODate = req.params.utcisodate;
    return res.redirect(`/${id}/before/${utcISODate}`);
  }
);

router.get(
  '/thing/:id/atom/:language',
  (req: ThingRouteRequest<{ id: string; language: string }>, res: ThingRouteResponse) => {
    const { id } = req.params;
    let language = req.params.language;
    return res.redirect(`/${id}/atom/${language}`);
  }
);

async function loadThingAndReviews(
  req: ThingRouteRequest<{ id: string }>,
  res: ThingRouteResponse,
  next: HandlerNext,
  thing: ThingInstance,
  offsetDate?: Date | null
) {
  try {
    thing.populateUserInfo(req.user);
    if (Array.isArray(thing.files)) {
      thing.files.forEach(file => file.populateUserInfo(req.user));
    }

    const otherReviewsPromise = ReviewHandle.getFeed({
      thingID: thing.id,
      withThing: false,
      withTeams: true,
      withoutCreator: req.user?.id,
      offsetDate,
    });

    const userReviewsPromise = thing.getReviewsByUser(req.user);

    const [otherReviews, userReviews] = await Promise.all([
      otherReviewsPromise,
      userReviewsPromise,
    ]);

    otherReviews.feedItems.forEach(review => {
      review.populateUserInfo(req.user);

      // Compute isLongReview flag for collapsible pattern
      const htmlContent = review.html?.[review.originalLanguage || 'en'] || '';
      review.isLongReview = htmlContent.length > 500;
    });

    // Compute isLongReview flag for user reviews
    userReviews.forEach(review => {
      const htmlContent = review.html?.[review.originalLanguage || 'en'] || '';
      review.isLongReview = htmlContent.length > 500;
    });

    sendThing(req, res, thing, {
      otherReviews,
      userReviews,
    });
  } catch (error) {
    next(error);
  }
}

function processTextFieldUpdate(
  req: ThingRouteRequest<{ id: string; field: string }>,
  res: ThingRouteResponse,
  next: HandlerNext
) {
  const { field, id } = req.params;

  if (!editableFields.includes(field)) return next();

  const titleKey = `edit ${field}`;

  slugs
    .resolveAndLoadThing(req, res, id)
    .then(thing => {
      thing.populateUserInfo(req.user);
      if (!thing.userCanEdit)
        return render.permissionError(req, res, {
          titleKey,
        });

      const syncConfig = (thing.sync ?? {}) as ThingSyncConfig;
      const descriptionSyncActive = Boolean(syncConfig.description?.active);
      if (field === 'description' && descriptionSyncActive)
        return render.permissionError(req, res, {
          titleKey,
          detailsKey: 'cannot edit synced field',
        });

      const languageValue = req.body?.['thing-language'];
      const language = typeof languageValue === 'string' ? languageValue : '';

      validateLanguage(req, language);

      const schema = buildThingEditSchema(field);
      const parseResult = schema.safeParse(req.body);

      if (!parseResult.success) {
        flashZodIssues(req, parseResult.error.issues, issue => formatZodIssueMessage(req, issue));
      }

      if (req.flashHas?.('pageErrors')) {
        const submittedValue = req.body?.[`thing-${field}`];
        const formValues = {
          [field]: typeof submittedValue === 'string' ? submittedValue : '',
        };
        return sendForm(req, res, thing, { [field]: true }, titleKey, formValues);
      }

      const text = parseResult.data[`thing-${field}`] as string;

      thing.newRevision(req.user).then(revision => {
        // Handle metadata fields (description, subtitle, authors) differently
        const metadataFields = ['description', 'subtitle', 'authors'];
        if (metadataFields.includes(field)) {
          const metadata = (revision.metadata ??= {} as Record<string, unknown>);
          const fieldMetadata = (metadata[field] ??= {}) as MultilingualString;
          fieldMetadata[language] = text; // Already escaped by schema
        } else {
          // Handle direct fields like label
          switch (field) {
            case 'label': {
              const label = (revision.label ??= {} as MultilingualString);
              label[language] = text; // Already escaped by schema
              break;
            }
            default: {
              const revisionRecord = revision as Record<string, unknown>;
              const fieldValue = (revisionRecord[field] ??= {}) as MultilingualString;
              fieldValue[language] = text; // Already escaped by schema
              break;
            }
          }
        }

        if (!revision.originalLanguage) revision.originalLanguage = language;

        let maybeUpdateSlug;
        if (field === 'label')
          // Must update slug to match label change
          maybeUpdateSlug =
            typeof revision.updateSlug === 'function'
              ? revision.updateSlug(req.user?.id, language)
              : Promise.resolve(revision);
        else maybeUpdateSlug = Promise.resolve(revision); // Nothing to do

        const handleSaveError = (error: unknown) => {
          req.flashError?.(error);
          const formValues = { [field]: text };
          sendForm(req, res, thing, { [field]: true }, titleKey, formValues);
        };

        maybeUpdateSlug
          .then(updatedRev => {
            updatedRev
              .save()
              .then(() => {
                search.indexThing(updatedRev);
                res.redirect(`/${id}`);
              })
              .catch(handleSaveError);
          })
          .catch(handleSaveError);
      });
    })
    .catch(getResourceErrorHandler(req, res, next, 'thing', id));
}

function sendForm(
  req: ThingRouteRequest<{ id: string }>,
  res: ThingRouteResponse,
  thing: ThingInstance,
  edit: Record<string, boolean>,
  titleKey: string,
  formValues?: Record<string, string>
) {
  edit = Object.assign(
    {
      label: false,
      description: false,
    },
    edit
  );
  let pageErrors = req.flash('pageErrors');
  let pageMessages = req.flash('pageMessages');
  let showLanguageNotice = false;
  const user = req.user;

  // If not suppressed, show a notice informing the user that UI language
  // is content language
  const suppressedNotices = Array.isArray(user?.suppressedNotices) ? user?.suppressedNotices : [];
  if (req.method === 'GET' && suppressedNotices.indexOf('language-notice-thing') === -1)
    showLanguageNotice = true;

  render.template(req, res, 'thing-form', {
    titleKey,
    deferPageHeader: true,
    thing,
    pageErrors,
    showLanguageNotice,
    pageMessages,
    edit,
    formValues,
  });
}

function sendThing(
  req: ThingRouteRequest<{ id: string }>,
  res: ThingRouteResponse,
  thing: ThingInstance,
  options: Partial<{ otherReviews: ReviewFeedResult; userReviews: ReviewInstance[] }> = {}
) {
  const resolvedOptions: {
    otherReviews?: ReviewFeedResult;
    userReviews: ReviewInstance[];
  } = {
    otherReviews: options.otherReviews,
    userReviews: options.userReviews ?? [],
  };

  let pageErrors = req.flash('pageErrors');
  let pageMessages = req.flash('pageMessages');
  let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
    atomURLPrefix: `/${thing.urlID}/atom`,
    atomURLTitleKey: 'atom feed of all reviews of this item',
  });

  let offsetDate =
    resolvedOptions.otherReviews && resolvedOptions.otherReviews.offsetDate
      ? resolvedOptions.otherReviews.offsetDate
      : undefined;

  let paginationURL;
  if (offsetDate) paginationURL = `/${thing.urlID}/before/${offsetDate.toISOString()}`;

  // If there are URLs beyond the main URL, we show them in categorized form
  let taggedURLs =
    Array.isArray(thing.urls) && thing.urls.length > 1
      ? urlUtils.getURLsByTag(thing.urls.slice(1), { onlyOneTag: true, sortResults: true })
      : {};

  render.template(
    req,
    res,
    'thing',
    {
      titleKey: 'reviews of',
      titleParam: Thing.getLabel(thing, req.locale),
      thing,
      pageErrors,
      pageMessages,
      embeddedFeeds,
      deferPageHeader: true,
      userReviews: resolvedOptions.userReviews,
      paginationURL,
      hasMoreThanOneReview:
        typeof thing.numberOfReviews === 'number' ? thing.numberOfReviews > 1 : false,
      otherReviews: resolvedOptions.otherReviews
        ? resolvedOptions.otherReviews.feedItems
        : undefined,
      taggedURLs,
      activeSourceIDs: thing.getSourceIDsOfActiveSyncs(),
      scripts: ['upload'],
    },
    {
      messages: {
        'one file selected': req.__('one file selected'),
        'files selected': req.__('files selected'),
      },
    }
  );
}

// Send the form for the "manage URLs" route, either with the current
// URLs, or with data from the POST request
function sendThingURLsForm(paramsObj: ThingURLsFormParams) {
  const { req, res, titleKey, thing, formValues } = paramsObj;
  const pageErrors = req.flash('pageErrors'),
    pageMessages = req.flash('pageMessages');
  const baseCount = Array.isArray(thing.urls) ? thing.urls.length : 0;
  let numberOfFields = baseCount + 2;
  render.template(
    req,
    res,
    'thing-urls',
    {
      titleKey,
      thing,
      numberOfFields,
      pageErrors,
      pageMessages,
      singleColumn: true,
      // Preserve submission content, if any
      urls: formValues ? formValues.urls : thing.urls,
      primary: formValues ? formValues.primary : 0,
      scripts: ['manage-urls'],
    },
    {
      messages: getMessages(req.locale, [
        'not a url',
        'add http',
        'add https',
        'enter web address short',
      ]),
    }
  );
}

// Handle data from a POST request for the "manage URLs" route
function processThingURLsUpdate(paramsObj: ThingURLsFormParams) {
  const { req, res, titleKey, thing } = paramsObj;
  const { schema, primaryField, urlsField } = buildThingURLsSchema(req);
  const parseResult = schema.safeParse(req.body);

  if (!parseResult.success) {
    flashZodIssues(req, parseResult.error.issues, issue =>
      formatZodIssueMessage(req, issue, 'unexpected form data')
    );
    const fallbackValues: Partial<ThingURLsFormValues> = {
      primary: safeParseField<number>(primaryField, req.body?.primary),
      urls: safeParseField<string[]>(urlsField, req.body?.urls),
    };
    return sendThingURLsForm({ req, res, titleKey, thing, formValues: fallbackValues });
  }

  const { urls: submittedURLs, primary } = parseResult.data;
  const formValues: ThingURLsFormValues = { urls: submittedURLs, primary };
  for (const value of submittedURLs) {
    if (value.length && !urlUtils.validate(value)) {
      req.flash('pageErrors', req.__('not a url'));
      return sendThingURLsForm({ req, res, titleKey, thing, formValues });
    }
  }

  const primaryURL = typeof submittedURLs?.[primary] === 'string' ? submittedURLs[primary] : '';
  if (!primaryURL.length) {
    req.flash('pageErrors', req.__('need primary'));
    return sendThingURLsForm({
      req,
      res,
      titleKey,
      thing,
      formValues,
    });
  }

  // The primary URL is simply the first one in the array, so we
  // have to re-order -- and also filter any empty fields. Validation
  // is done by the model (and client-side for JS users).
  const normalizedURLs = Array.isArray(submittedURLs) ? submittedURLs : [];
  let thingURLs = [primaryURL].concat(
    normalizedURLs.filter(url => typeof url === 'string' && url !== primaryURL && url.length)
  );

  // Now we need to make sure that none of the URLs are currently in use.
  const urlLookups = thingURLs.map(url =>
    Thing.filterWhere({
      urls: Thing.ops.containsAll(url),
      id: Thing.ops.neq(thing.id),
    }).run()
  );

  // Perform lookups
  Promise.all(urlLookups)
    .then(results => {
      let hasDuplicate = false;
      results.forEach((matches, index) => {
        if (matches.length) {
          req.flash(
            'pageErrors',
            req.__('web address already in use', thingURLs[index], `/${matches[0].urlID}`)
          );
          hasDuplicate = true;
        }
      });

      if (hasDuplicate) return sendThingURLsForm({ req, res, titleKey, thing, formValues });

      // No dupes -- continue!
      thing.newRevision(req.user).then(revision => {
        // Reset sync settings for adapters
        revision.setURLs(thingURLs);
        // Fetch external data for any URLs that support it and update thing, search index
        const userID = req.user?.id;
        if (!userID) throw new Error('Missing signed-in user ID while updating thing URLs.');
        revision
          .updateActiveSyncs(userID)
          .then(() => {
            req.flash('pageMessages', req.__('links updated'));
            sendThingURLsForm({ req, res, titleKey, thing: revision });
          })
          .catch(error => {
            // Problem with syncs
            req.flashError?.(error);
            sendThingURLsForm({ req, res, titleKey, thing, formValues });
          });
      });
    })
    .catch(error => {
      // Problem with lookup
      req.flashError?.(error);
      sendThingURLsForm({ req, res, titleKey, thing, formValues });
    });
}

export default router;
