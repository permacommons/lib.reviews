// External dependencies
import { resolve as resolveURL } from 'node:url';
import config from 'config';
import i18n from 'i18n';
import languages from '../../locales/languages.ts';
import type { ReviewFeedResult } from '../../models/manifests/review.ts';
import Review from '../../models/review.ts';
// Internal dependencies
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import feeds from '../helpers/feeds.ts';
import render from '../helpers/render.ts';

const reviewHandlers = {
  getFeedHandler(options) {
    options = Object.assign(
      {
        // Defaults
        titleKey: 'feed',
        titleParam: undefined,
        template: 'feed',
        // Show only reviews by users with isTrusted = true, useful as pre-screen
        onlyTrusted: false,
        deferPageHeader: false,
        // Reviews per page, also applies to machine-readable feeds
        limit: 10,
        // Set to ID if we need to filter by user
        createdBy: undefined,
        // Anything else we need to pass into the template
        extraVars: {},
        // For <link> tags in generated output. The feed itself uses titleKey
        // as the title.
        atomURLPrefix: '/feed/atom',
        atomURLTitleKey: 'atom feed of all reviews',
        htmlURL: '/feed',
      },
      options
    );

    return async (req: HandlerRequest, res: HandlerResponse, next: HandlerNext) => {
      let language: string | undefined;
      let offsetDate: Date | null | undefined;
      if (typeof req.params.utcisodate === 'string') {
        const parsedDate = new Date(req.params.utcisodate.trim());
        offsetDate = Number.isNaN(parsedDate.valueOf()) ? null : parsedDate;
      }

      // Feeds for external consumption require a language, we fall back to
      // English if we can't find one
      if (options.format) {
        const languageParam = req.params.language;
        language = typeof languageParam === 'string' ? languageParam : undefined;
        if (!language || !languages.isValid(language)) language = 'en';
      }

      Review.getFeed({
        onlyTrusted: options.onlyTrusted,
        limit: options.limit,
        offsetDate,
        createdBy: options.createdBy,
        withThing: true,
        withTeams: true,
      })
        .then(result => {
          const feedItems = result.feedItems ?? [];
          const nextOffsetDate = result.offsetDate;

          let updatedDate;

          feedItems.forEach(item => {
            item.populateUserInfo?.(req.user);
            if (item.thing) item.thing.populateUserInfo?.(req.user);

            // For Atom feed - most recently modified item in the result set
            if (!updatedDate || item._revDate > updatedDate) updatedDate = item._revDate;
          });

          let paginationURL;
          if (nextOffsetDate) {
            if (options.paginationURL)
              paginationURL = options.paginationURL.replace(
                '%isodate',
                nextOffsetDate.toISOString()
              );
            else paginationURL = `/feed/before/${nextOffsetDate.toISOString()}`;
          }

          const vars: Record<string, unknown> = {
            titleKey: options.titleKey,
            titleParam: options.titleParam,
            deferPageHeader: options.deferPageHeader,
            feedItems,
            paginationURL,
            pageLimit: options.limit,
            embeddedFeeds: feeds.getEmbeddedFeeds(req, options),
          };

          if (options.extraVars && typeof options.extraVars === 'object')
            Object.assign(vars, options.extraVars);

          if (!options.format) {
            render.template(req, res, options.template, vars);
          } else if (options.format == 'atom') {
            const feedLanguage = language ?? 'en';
            Object.assign(vars, {
              layout: 'layout-atom',
              language: feedLanguage,
              updatedDate,
              selfURL: resolveURL(config.qualifiedURL, options.atomURLPrefix) + `/${feedLanguage}`,
              htmlURL: resolveURL(config.qualifiedURL, options.htmlURL),
            });
            i18n.setLocale(req, feedLanguage);
            res.type('application/atom+xml');
            render.template(req, res, 'review-feed-atom', vars);
          } else throw new Error(`Format '${options.format}' not supported.`);
        })
        .catch(next);
    };
  },
};

export default reviewHandlers;
