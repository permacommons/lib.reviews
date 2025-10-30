import escapeHTML from 'escape-html';

import render from '../helpers/render.mjs';
import feeds from '../helpers/feeds.mjs';
import User from '../../models/user.js';
import Review from '../../models/review.js';
import reviewHandlers from './review-handlers.mjs';
import md from '../../util/md.js';
import frontendMessages from '../../util/frontend-messages.js';

const userHandlers = {

  async processEdit(req, res, next) {
    const { name } = req.params;

    try {

      const user = await User.findByURLName(name, {
        withData: true
      });

      user.populateUserInfo(req.user);
      if (!user.userCanEditMetadata)
        return render.permissionError(req, res, next);

      let bio = req.body['bio-text'];
      let bioLanguage = req.body['bio-language'];
      if (bio === undefined || bioLanguage === undefined) {
        req.flash('pageErrors', req.__('data missing'));
        return res.redirect(`/user/${user.urlName}/edit/bio`);
      }

      if (user.meta === undefined || user.meta === null || user.meta.bio === undefined) {
        let bioObj = {
          bio: {
            text: {},
            html: {}
          },
          originalLanguage: bioLanguage
        };
        bioObj.bio.text[bioLanguage] = escapeHTML(bio);
        bioObj.bio.html[bioLanguage] = md.render(bio, { language: req.locale });
        bioObj.originalLanguage = bioLanguage;

        await User.createBio(user, bioObj);
        req.flash('pageMessages', req.__('edit saved'));
        res.redirect(`/user/${user.urlName}`);
      } else {
        let metaRev = await user.meta.newRevision(req.user, {
          tags: ['update-bio-via-user']
        });

        if (metaRev.bio === undefined)
          metaRev.bio = {};

        metaRev.bio.text[bioLanguage] = escapeHTML(bio);
        metaRev.bio.html[bioLanguage] = md.render(bio, { language: req.locale });

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

    return async function(req, res, next) {
      const { name } = req.params;
      try {
        const user = await User.findByURLName(name, {
          withData: true,
          withTeams: true
        });

        user.populateUserInfo(req.user);

        if (options.editBio && !user.userCanEditMetadata)
          return render.permissionError(req, res, next);

        if (decodeURIComponent(user.urlName) !== name)
          return res.redirect(`/user/${user.urlName}`);



        const result = await Review.getFeed({
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
          messages: loadEditor ? frontendMessages.getEditorMessages(req.locale) : {}
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

    return async function(req, res, next) {

      const { name } = req.params;
      let offsetDate;
      if (req.params.utcisodate) {
        offsetDate = new Date(req.params.utcisodate);
        if (!offsetDate || offsetDate == 'Invalid Date')
          offsetDate = null;
      }

      try {
        const user = await User.findByURLName(name);

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
