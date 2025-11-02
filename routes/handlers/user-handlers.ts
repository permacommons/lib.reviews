import escapeHTML from 'escape-html';

import type { HandlerRequest, HandlerResponse, HandlerNext } from '../../types/http/handlers.ts';
import render from '../helpers/render.ts';
import feeds from '../helpers/feeds.ts';
import User from '../../models/user.ts';
import Review from '../../models/review.ts';
import reviewHandlers from './review-handlers.ts';
import md from '../../util/md.ts';
import frontendMessages from '../../util/frontend-messages.ts';

const UserModel = User as any;
const ReviewModel = Review as any;

const userHandlers = {

  async processEdit(req: HandlerRequest, res: HandlerResponse, next: HandlerNext) {
    const { name } = req.params;

    try {

      const user = await UserModel.findByURLName(name, {
        withData: true
      });

      user.populateUserInfo(req.user);
      if (!user.userCanEditMetadata)
        return render.permissionError(req, res);

      const bio = typeof req.body['bio-text'] === 'string' ? req.body['bio-text'] : undefined;
      const bioLanguage = typeof req.body['bio-language'] === 'string' ? req.body['bio-language'] : undefined;
      if (bio === undefined || bioLanguage === undefined) {
        req.flash('pageErrors', req.__('data missing'));
        return res.redirect(`/user/${user.urlName}/edit/bio`);
      }

      if (user.meta === undefined || user.meta === null || user.meta.bio === undefined) {
        const bioObj: Record<string, any> = {
          bio: {
            text: {} as Record<string, string>,
            html: {} as Record<string, string>
          },
          originalLanguage: bioLanguage
        };
        bioObj.bio.text[bioLanguage] = escapeHTML(bio);
        bioObj.bio.html[bioLanguage] = md.render(bio, { language: req.locale });
        bioObj.originalLanguage = bioLanguage;

        await UserModel.createBio(user, bioObj);
        req.flash('pageMessages', req.__('edit saved'));
        res.redirect(`/user/${user.urlName}`);
      } else {
        const metaRev = await user.meta.newRevision(req.user, {
          tags: ['update-bio-via-user']
        });

        const bioData = (metaRev.bio as Record<string, any>) ?? { text: {}, html: {} };
        if (!bioData.text || typeof bioData.text !== 'object')
          bioData.text = {};
        if (!bioData.html || typeof bioData.html !== 'object')
          bioData.html = {};
        bioData.text[bioLanguage] = escapeHTML(bio);
        bioData.html[bioLanguage] = md.render(bio, { language: req.locale });
        metaRev.bio = bioData;

        await metaRev.save();
        req.flash('pageMessages', req.__('edit saved'));
        res.redirect(`/user/${user.urlName}`);
      }
    } catch (error) {
      return userHandlers.getUserNotFoundHandler(req, res, next, name)(error);
    }
  },

  getUserHandler(options) {
    options = Object.assign({
      editBio: false
    }, options);

    return async function(req: HandlerRequest, res: HandlerResponse, next: HandlerNext) {
      const { name } = req.params;
      try {
        const user = await UserModel.findByURLName(name, {
          withData: true,
          withTeams: true
        });

        user.populateUserInfo(req.user);

        if (options.editBio && !user.userCanEditMetadata)
          return render.permissionError(req, res);

        if (decodeURIComponent(user.urlName) !== name)
          return res.redirect(`/user/${user.urlName}`);



        const result = await ReviewModel.getFeed({
          createdBy: user.id,
          limit: 3,
          withThing: true,
          withTeams: true
        });

        let feedItems = result.feedItems;
        let offsetDate = result.offsetDate;

        for (let item of feedItems) {
          item.populateUserInfo(req.user);
          if (item.thing) {
            item.thing.populateUserInfo(req.user);
          }
        }

        let edit = {
          bio: options.editBio
        };

        let loadEditor = options.editBio;

        // For easy lookup in template
        let modOf = {};
        user.moderatorOf.forEach(t => (modOf[t.id] = true));

        let founderOf = {};
        user.teams.forEach(t => {
          if (t.createdBy && t.createdBy == user.id)
            founderOf[t.id] = true;
        });

        let pageErrors = req.flash('pageErrors');
        let pageMessages = req.flash('pageMessages');

        let embeddedFeeds = feeds.getEmbeddedFeeds(req, {
          atomURLPrefix: `/user/${user.urlName}/feed/atom`,
          atomURLTitleKey: `atom feed of reviews by this user`,
        });


        let paginationURL;
        if (offsetDate)
          paginationURL = `/user/${user.urlName}/feed/before/${offsetDate.toISOString()}`;

        render.template(req, res, 'user', {
          titleKey: 'user',
          titleParam: user.displayName,
          deferPageHeader: true, // two-col layout
          userInfo: user,
          feedItems,
          edit,
          scripts: loadEditor ? ['user', 'editor'] : ['user'],
          pageErrors,
          pageMessages,
          teams: user.teams,
          modOf,
          founderOf,
          paginationURL,
          embeddedFeeds
        }, {
          messages: loadEditor ? frontendMessages.getEditorMessages(typeof req.locale === 'string' ? req.locale : 'en') : {}
        });
      } catch (error) {
        return userHandlers.getUserNotFoundHandler(req, res, next, name)(error);
      }
    };
  },

  getUserFeedHandler(options) {

    options = Object.assign({
      format: undefined
    }, options);

    return async function(req: HandlerRequest, res: HandlerResponse, next: HandlerNext) {

      const { name } = req.params;
      let offsetDate;
      if (req.params.utcisodate) {
        offsetDate = new Date(req.params.utcisodate);
        if (!offsetDate || offsetDate == 'Invalid Date')
          offsetDate = null;
      }

      try {
        const user = await UserModel.findByURLName(name);

        if (decodeURIComponent(user.urlName) !== name) {
          // Redirect to chosen display form
          return res.redirect(`/user/${user.urlName}/feed` + (offsetDate ?
            `/before/${offsetDate.toISOString()}` : ''));
        }

        reviewHandlers.getFeedHandler({
          format: options.format,
          titleKey: 'user feed',
          titleParam: user.displayName,
          createdBy: user.id,
          paginationURL: `/user/${user.urlName}/feed/before/%isodate`,
          deferPageHeader: true,
          atomURLPrefix: `/user/${user.urlName}/feed/atom`,
          atomURLTitleKey: `atom feed of reviews by this user`,
          htmlURL: `/user/${user.urlName}/feed`,
          extraVars: {
            userURL: `/user/${user.urlName}`,
            userInfo: user
          }
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
      name: escapeHTML(name)
    });
  },

  getUserNotFoundHandler(req, res, next, name) {
    return function(error) {
      if (error.name == 'DocumentNotFound' || error.name == 'DocumentNotFoundError')
        userHandlers.sendUserNotFound(req, res, name);
      else
        return next(error);
    };
  }

};

export default userHandlers;
