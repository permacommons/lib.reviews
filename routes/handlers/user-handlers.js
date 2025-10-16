'use strict';
const escapeHTML = require('escape-html');

const render = require('../helpers/render');
const feeds = require('../helpers/feeds');
const User = require('../../models/user');
const Review = require('../../models/review');
const reviewHandlers = require('./review-handlers');
const md = require('../../util/md');
const { getEditorMessages } = require('../../util/frontend-messages');

let userHandlers = {

  processEdit(req, res, next) {

    const { name } = req.params;
    User
      .findByURLName(name, {
        withData: true,
        withPassword: true // Since user needs to be updated
      })
      .then(user => {
        user.populateUserInfo(req.user);
        if (!user.userCanEditMetadata)
          return render.permissionError(req, res, next);

        let bio = req.body['bio-text'];
        let bioLanguage = req.body['bio-language'];
        if (bio === undefined || bioLanguage === undefined) {
          req.flash('pageErrors', req.__('data missing'));
          return res.redirect(`/user/${user.urlName}/edit/bio`);
        }

        if (user.meta === undefined || user.meta.bio === undefined) {
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
          User
            .createBio(user, bioObj)
            .then(() => {
              res.redirect(`/user/${user.urlName}`);
            })
            .catch(next);
        } else {
          user.meta
            .newRevision(req.user, {
              tags: ['update-bio-via-user']
            })
            .then(metaRev => {
              if (metaRev.bio === undefined)
                metaRev.bio = {};

              metaRev.bio.text[bioLanguage] = escapeHTML(bio);
              metaRev.bio.html[bioLanguage] = md.render(bio, { language: req.locale });
              metaRev
                .save()
                .then(() => {
                  res.redirect(`/user/${user.urlName}`);
                })
                .catch(next); // Problem saving metadata
            })
            .catch(next); // Problem creating metadata revision
        }
      })
      .catch(userHandlers.getUserNotFoundHandler(req, res, next, name));
  },

  getUserHandler(options) {
    options = Object.assign({
      editBio: false
    }, options);

    return function(req, res, next) {
      const { name } = req.params;

      User
        .findByURLName(name, {
          withData: true,
          withTeams: true
        })
        .then(user => {

          user.populateUserInfo(req.user);

          if (options.editBio && !user.userCanEditMetadata)
            return render.permissionError(req, res, next);

          if (decodeURIComponent(user.urlName) !== name) // Redirect to chosen display name form (with spaces as underscores)
            return res.redirect(`/user/${user.urlName}`);

          Review
            .getFeed({
              createdBy: user.id,
              limit: 3
            })
            .then(result => {
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
                teams: user.teams,
                modOf,
                founderOf,
                paginationURL,
                embeddedFeeds
              }, {
                messages: loadEditor ? getEditorMessages(req.locale) : {}
              }
            );
            })
            .catch(next);
        })
        .catch(userHandlers.getUserNotFoundHandler(req, res, next, name));
    };
  },

  getUserFeedHandler(options) {

    options = Object.assign({
      format: undefined
    }, options);

    return function(req, res, next) {

      const { name } = req.params;
      let offsetDate;
      if (req.params.utcisodate) {
        offsetDate = new Date(req.params.utcisodate);
        if (!offsetDate || offsetDate == 'Invalid Date')
          offsetDate = null;
      }

      User
        .findByURLName(name)
        .then(user => {

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

        }) // No user
        .catch(userHandlers.getUserNotFoundHandler(req, res, next, name));
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
      if (error.name == 'DocumentNotFoundError')
        userHandlers.sendUserNotFound(req, res, name);
      else
        return next(error);
    };
  }

};

module.exports = userHandlers;
