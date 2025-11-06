import { Router } from 'express';
import languages from '../locales/languages.ts';
import Thing from '../models/thing.ts';
import User from '../models/user.ts';
import search from '../search.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import urlUtils from '../util/url-utils.ts';
import actionHandler from './handlers/action-handler.ts';

type ApiRouteRequest = HandlerRequest;
type ApiRouteResponse = HandlerResponse;

const router = Router();

// For true/false user preferences.
router.post('/actions/:modify-preference', actionHandler.modifyPreference);

router.post('/actions/suppress-notice', actionHandler.suppressNotice);

router.post('/actions/upload', actionHandler.upload);

// Query existence/properties of a thing (review subject)
// look up by canonical URL name via /thing/:label or use URL query parameter
// e.g., ?url=http://yahoo.com
router.get('/thing', (req: ApiRouteRequest, res: ApiRouteResponse, next: HandlerNext) => {
  const urlQuery = req.query.url;
  const urlParam =
    typeof urlQuery === 'string'
      ? urlQuery
      : Array.isArray(urlQuery)
        ? String(urlQuery[0] ?? '')
        : undefined;
  if (urlParam) {
    const rv: Record<string, unknown> = {};
    const failureMsg = 'Could not retrieve review subject.';
    const userID = typeof req.query.userID === 'string' ? req.query.userID : undefined;

    if (!urlUtils.validate(urlParam)) {
      rv.message = failureMsg;
      rv.errors = ['URL is not valid.'];
      res.status(400);
      res.type('json');
      res.send(JSON.stringify(rv, null, 2));
      return;
    }

    Thing.lookupByURL(urlUtils.normalize(urlParam), userID)
      .then(things => {
        const [thing] = things;
        if (!thing) {
          res.status(404);
          rv.message = failureMsg;
          rv.errors = ['URL not found.'];
          res.type('json');
          res.send(JSON.stringify(rv, null, 2));
        } else {
          thing
            .populateReviewMetrics()
            .then(() => {
              res.status(200);
              rv.thing = {
                id: thing.id,
                label: thing.label,
                aliases: thing.aliases,
                description: thing.description,
                originalLanguage: thing.originalLanguage,
                canonicalSlugName: thing.canonicalSlugName,
                urlID: thing.urlID,
                createdOn: thing.createdOn,
                createdBy: thing.createdBy,
                numberOfReviews: thing.numberOfReviews,
                averageStarRating: thing.averageStarRating,
                urls: thing.urls,
                reviews: thing.reviews,
              };
              res.type('json');
              res.send(JSON.stringify(rv, null, 2));
            })
            .catch(next);
        }
      })
      .catch(next);
  }
});

// Search suggestions
router.get(
  '/suggest/thing/:prefix',
  (req: ApiRouteRequest, res: ApiRouteResponse, next: HandlerNext) => {
    const prefix = req.params.prefix.trim();
    const localeCode: LibReviews.LocaleCode = languages.isValid(req.locale)
      ? (req.locale as LibReviews.LocaleCode)
      : 'en';
    search
      .suggestThing(prefix, localeCode)
      .then(results => {
        const rv: Record<string, unknown> = {};

        // Simplify ElasticSearch result structure for API use (flatten, strip
        // metadata; strip unneeded source data)
        const suggestions = (results as Record<string, any>).suggest as Record<string, any[]>;
        rv.results = suggestions;
        for (const key of Object.keys(suggestions)) {
          const entries = suggestions[key][0].options;
          for (const option of entries) {
            option.urlID = option._source.urlID;
            option.urls = option._source.urls;
            option.description = option._source.description;
            Reflect.deleteProperty(option, '_source');
            Reflect.deleteProperty(option, '_index');
          }
          suggestions[key] = entries;
        }

        res.type('json');
        res.status(200);
        res.send(JSON.stringify(rv, null, 2));
      })
      .catch(next);
  }
);

router.get('/user/:name', (req: ApiRouteRequest, res: ApiRouteResponse) => {
  const { name } = req.params;
  const rv: Record<string, unknown> = {};
  User.filter({
    canonicalName: User.canonicalize(name),
  }).then(result => {
    if (result.length) {
      let user = result[0];
      rv.id = user.id;
      rv.displayName = user.displayName;
      rv.canonicalName = user.canonicalName;
      rv.registrationDate = user.registrationDate;
      rv.isSiteModerator = user.isSiteModerator;
      res.status(200);
    } else {
      rv.message = 'Could not retrieve user data.';
      rv.errors = ['User does not exist.'];
      res.status(404);
    }
    res.type('json');
    res.send(JSON.stringify(rv, null, 2));
  });
});

export default router;
