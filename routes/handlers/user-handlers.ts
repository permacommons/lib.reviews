import escapeHTML from 'escape-html';
import { RevisionConflictError } from 'rev-dal/lib/errors';
import type { MultilingualRichText } from 'rev-dal/lib/ml-string';
import type { TeamInstance } from '../../models/manifests/team.ts';
import type { UserInstance } from '../../models/manifests/user.ts';
import type { UserMetaInstance } from '../../models/manifests/user-meta.ts';
import Review from '../../models/review.ts';
import User from '../../models/user.ts';
import UserMeta from '../../models/user-meta.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../../types/http/handlers.ts';
import frontendMessages from '../../util/frontend-messages.ts';
import md from '../../util/md.ts';
import {
  flashEditConflict,
  getSubmittedRevID,
  hasEditConflict,
} from '../helpers/edit-conflicts.ts';
import feeds from '../helpers/feeds.ts';
import render from '../helpers/render.ts';
import getResourceErrorHandler from './resource-error-handler.ts';
import reviewHandlers from './review-handlers.ts';

const userHandlers = {
  async processEdit(req: HandlerRequest, res: HandlerResponse, next: HandlerNext) {
    const { name } = req.params;

    try {
      const user = await User.findByURLName(name, {
        withData: true,
      });

      user.populateUserInfo(req.user);
      if (!user.userCanEditMetadata) return render.permissionError(req, res);

      const bio = typeof req.body['bio-text'] === 'string' ? req.body['bio-text'] : undefined;
      const bioLanguage =
        typeof req.body['bio-language'] === 'string' ? req.body['bio-language'] : undefined;
      if (bio === undefined || bioLanguage === undefined) {
        req.flash('pageErrors', req.__('data missing'));
        return res.redirect(`/user/${user.urlName}/edit/bio`);
      }

      if (user.meta === undefined || user.meta === null || user.meta.bio === undefined) {
        const bioObj = {
          bio: {
            text: { [bioLanguage]: escapeHTML(bio) },
            html: { [bioLanguage]: md.render(bio, { language: req.locale }) },
          },
          originalLanguage: bioLanguage,
        };

        await User.createBio(user, bioObj);
        req.flash('pageMessages', req.__('edit saved'));
        res.redirect(`/user/${user.urlName}`);
      } else {
        const meta = user.meta as UserMetaInstance;
        const conflict = await hasEditConflict(
          UserMeta,
          meta,
          getSubmittedRevID(req.body),
          rev => (rev.bio as MultilingualRichText | undefined)?.text?.[bioLanguage]
        );
        if (conflict) {
          const pageUser = await User.findByURLName(name, { withData: true, withTeams: true });
          pageUser.populateUserInfo(req.user);
          flashEditConflict(req, `/user/${user.urlName}`);
          res.status(409);
          return await userHandlers.sendUserPage(req, res, pageUser, {
            editBio: true,
            bioForm: { text: bio },
            bioRevID: meta._revID,
          });
        }

        const metaRev = await meta.newRevision(req.user, {
          tags: ['update-bio-via-user'],
        });

        const existingBio = metaRev.bio as MultilingualRichText | undefined;
        const bioData: Required<MultilingualRichText> = {
          text: existingBio?.text ?? {},
          html: existingBio?.html ?? {},
        };
        bioData.text[bioLanguage] = escapeHTML(bio);
        bioData.html[bioLanguage] = md.render(bio, { language: req.locale });
        metaRev.bio = bioData;

        await metaRev.save();
        req.flash('pageMessages', req.__('edit saved'));
        res.redirect(`/user/${user.urlName}`);
      }
    } catch (error) {
      if (error instanceof RevisionConflictError)
        return getResourceErrorHandler(req, res, next, 'user', name)(error);
      return userHandlers.getUserNotFoundHandler(req, res, next, name)(error);
    }
  },

  getUserHandler(options) {
    options = Object.assign(
      {
        editBio: false,
      },
      options
    );

    return async (req: HandlerRequest, res: HandlerResponse, next: HandlerNext) => {
      const { name } = req.params;
      try {
        const user = await User.findByURLName(name, {
          withData: true,
          withTeams: true,
        });

        user.populateUserInfo(req.user);

        if (options.editBio && !user.userCanEditMetadata) return render.permissionError(req, res);

        if (decodeURIComponent(user.urlName) !== name) return res.redirect(`/user/${user.urlName}`);

        await userHandlers.sendUserPage(req, res, user, {
          editBio: options.editBio,
          bioRevID: options.editBio ? user.meta?._revID : undefined,
        });
      } catch (error) {
        return userHandlers.getUserNotFoundHandler(req, res, next, name)(error);
      }
    };
  },

  // Render a user's page, optionally with the bio form
  async sendUserPage(
    req: HandlerRequest,
    res: HandlerResponse,
    user: UserInstance,
    options: { editBio: boolean; bioForm?: { text: string }; bioRevID?: string }
  ) {
    const result = await Review.getFeed({
      createdBy: user.id,
      limit: 3,
      withThing: true,
      withTeams: true,
    });

    let feedItems = result.feedItems;
    let offsetDate = result.offsetDate;

    for (let item of feedItems) {
      item.populateUserInfo(req.user);
      if (item.thing) {
        item.thing.populateUserInfo(req.user);
      }

      // Compute isLongReview flag for collapsible pattern
      const htmlContent = item.html?.[item.originalLanguage || 'en'] || '';
      item.isLongReview = htmlContent.length > 500;
    }

    let edit = {
      bio: options.editBio,
    };

    let loadEditor = options.editBio;

    // For easy lookup in template
    const modOf: Record<string, boolean> = {};
    (user.moderatorOf as TeamInstance[] | undefined)?.forEach(t => (modOf[t.id] = true));

    const founderOf: Record<string, boolean> = {};
    (user.teams as TeamInstance[] | undefined)?.forEach(t => {
      if (t.createdBy && t.createdBy == user.id) founderOf[t.id] = true;
    });

    let pageErrors = req.flash('pageErrors');
    let pageMessages = req.flash('pageMessages');

    let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
      atomURLPrefix: `/user/${user.urlName}/feed/atom`,
      atomURLTitleKey: 'atom feed of reviews by this user',
    });

    let paginationURL;
    if (offsetDate) paginationURL = `/user/${user.urlName}/feed/before/${offsetDate.toISOString()}`;

    const isOwnPage = req.user?.id === user.id;

    render.template(
      req,
      res,
      'user',
      {
        titleKey: 'user',
        titleParam: user.displayName,
        deferPageHeader: true, // two-col layout
        userInfo: user,
        isOwnPage,
        feedItems,
        edit,
        scripts: loadEditor ? ['user', 'editor'] : ['user'],
        pageErrors,
        pageMessages,
        teams: user.teams,
        modOf,
        founderOf,
        paginationURL,
        embeddedFeeds,
        bioForm: options.bioForm,
        bioRevID: options.bioRevID,
      },
      {
        messages: loadEditor
          ? frontendMessages.getEditorMessages(typeof req.locale === 'string' ? req.locale : 'en')
          : {},
      }
    );
  },

  getUserFeedHandler(options) {
    options = Object.assign(
      {
        format: undefined,
      },
      options
    );

    return async (req: HandlerRequest, res: HandlerResponse, next: HandlerNext) => {
      const { name } = req.params;
      let offsetDate;
      if (req.params.utcisodate) {
        offsetDate = new Date(req.params.utcisodate);
        if (!offsetDate || offsetDate == 'Invalid Date') offsetDate = null;
      }

      try {
        const user = await User.findByURLName(name);

        if (decodeURIComponent(user.urlName) !== name) {
          // Redirect to chosen display form
          return res.redirect(
            `/user/${user.urlName}/feed` + (offsetDate ? `/before/${offsetDate.toISOString()}` : '')
          );
        }

        reviewHandlers.getFeedHandler({
          format: options.format,
          titleKey: 'user feed',
          titleParam: user.displayName,
          createdBy: user.id,
          paginationURL: `/user/${user.urlName}/feed/before/%isodate`,
          deferPageHeader: true,
          atomURLPrefix: `/user/${user.urlName}/feed/atom`,
          atomURLTitleKey: 'atom feed of reviews by this user',
          htmlURL: `/user/${user.urlName}/feed`,
          extraVars: {
            userURL: `/user/${user.urlName}`,
            userInfo: user,
          },
        })(req, res, next);
      } catch (error) {
        return userHandlers.getUserNotFoundHandler(req, res, next, name)(error);
      }
    };
  },

  sendUserNotFound(req, res, name) {
    res.status(404);
    render.template(req, res, 'no-user', {
      titleKey: 'user not found',
      name: escapeHTML(name),
    });
  },

  getUserNotFoundHandler(req, res, next, name) {
    return error => {
      if (error.name == 'DocumentNotFound' || error.name == 'DocumentNotFoundError')
        userHandlers.sendUserNotFound(req, res, name);
      else return next(error);
    };
  },
};

export default userHandlers;
