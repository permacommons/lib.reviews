import express from 'express';
import passport from 'passport';
import config from 'config';
import i18n from 'i18n';

import render from './helpers/render.ts';
import forms from './helpers/forms.ts';
import User from '../models/user.js';
import InviteLink from '../models/invite-link.js';
import debug from '../util/debug.ts';
import actionHandler from './handlers/action-handler.js';
import signinRequiredRoute from './handlers/signin-required-route.js';
import languages from '../locales/languages.js';
import search from '../search.js';

const router = express.Router();

const formDefs = {
  'register': [{
    name: 'username',
    required: true
  }, {
    name: 'password',
    required: true,
  }, {
    name: 'email',
    required: false
  }, {
    name: 'returnTo',
    required: false
  }, {
    name: 'signupLanguage',
    required: false
  }]
};


router.get('/actions/search', function (req, res, next) {
  let query = (req.query.query || '').trim();
  if (query) {
    Promise
      .all([search.searchThings(query, req.locale), search.searchReviews(query, req.locale)])
      .then(results => {
        let labelMatches = results[0].hits.hits;
        let textMatches = search.filterDuplicateInnerHighlights(results[1].hits.hits, 'review');
        let noMatches = !labelMatches.length && !textMatches.length;

        render.template(req, res, 'search', {
          titleKey: 'search results',
          noMatches,
          labelMatches,
          textMatches,
          query,
          showHelp: noMatches,
          deferPageHeader: true
        });
      })
      .catch(next);
  } else {
    render.template(req, res, 'search', {
      titleKey: 'search lib.reviews',
      showHelp: true,
      deferPageHeader: true
    });
  }
});

router.get('/actions/invite', signinRequiredRoute('invite users', renderInviteLinkPage));

router.post('/actions/invite', signinRequiredRoute('invite users', async function (req, res, next) {
  try {
    if (!req.user.inviteLinkCount) {
      req.flash('pageErrors', res.__('out of links'));
      return renderInviteLinkPage(req, res, next);
    }

    let inviteLink = new InviteLink({});
    inviteLink.createdOn = new Date();
    inviteLink.createdBy = req.user.id;
    let p1 = inviteLink.save();

    req.user.inviteLinkCount--;
    let p2 = req.user.save();

    await Promise.all([p1, p2]);

    req.flash('pageMessages', res.__('link generated'));
    return renderInviteLinkPage(req, res, next);
  } catch (error) {
    next(error);
  }
}));


async function renderInviteLinkPage(req, res, next) {
  try {
    const [pendingInviteLinks, usedInviteLinks] = await Promise.all([
      InviteLink.getAvailable(req.user),
      InviteLink.getUsed(req.user)
    ]);

    render.template(req, res, 'invite', {
      titleKey: res.locals.titleKey,
      invitePage: true, // to tell template not to show call-to-action again
      pendingInviteLinks,
      usedInviteLinks,
      pageErrors: req.flash('pageErrors'),
      pageMessages: req.flash('pageMessages')
    });
  } catch (error) {
    next(error);
  }
}

router.post('/actions/suppress-notice', actionHandler.suppressNotice);

router.post('/actions/change-language', function (req, res) {
  let maxAge = 1000 * 60 * config.sessionCookieDuration; // cookie age: 30 days
  let lang = req.body.lang;
  let redirectTo = req.body['redirect-to'];

  let hasLanguageNotice = req.body['has-language-notice'] ? true : false;

  if (!languages.isValid(lang)) {
    req.flash('siteErrors', req.__('invalid language'));
    if (redirectTo)
      return res.redirect(redirectTo);
    else
      return redirectBackOrHome(req, res);
  }

  res.cookie('locale', lang, {
    maxAge,
    httpOnly: true
  });
  i18n.setLocale(req, lang);

  // Don't show on pages with language notices on them, to avoid message overkill.
  if (!hasLanguageNotice)
    req.flash('siteMessages', req.__('notification language-changed'));

  if (redirectTo)
    res.redirect(redirectTo);
  else
    redirectBackOrHome(req, res);
});

// Below actions have shorter names for convenience

router.get('/signin', function (req, res) {
  let pageErrors = req.flash('pageErrors');
  render.template(req, res, 'signin', {
    titleKey: 'sign in',
    pageErrors
  });
});


router.post('/signin', function (req, res, next) {
  if (!req.body.username || !req.body.password) {
    if (!req.body.username)
      req.flash('pageErrors', req.__('need username'));
    if (!req.body.password)
      req.flash('pageErrors', req.__('need password'));
    return res.redirect('/signin');
  }

  passport.authenticate('local', function (error, user, info) {
    if (error) {
      debug.error({ req, error });
      return res.redirect('/signin');
    }
    if (!user) {
      if (info && info.message) {
        req.flash('pageErrors', res.__(info.message));
      }
      return res.redirect('/signin');
    }
    req.login(user, function (error) {
      if (error) {
        debug.error({ req, error });
        return res.redirect('/signin');
      } else {
        return returnToPath(req, res); // Success
      }
    });
  })(req, res, next);
});


router.get('/new/user', function (req, res) {
  res.redirect('/register');
});

router.get('/register', function (req, res, next) {
  viewInSignupLanguage(req);
  if (config.requireInviteLinks)
    return render.template(req, res, 'invite-needed', {
      titleKey: 'register'
    });
  else
    return sendRegistrationForm(req, res);
});

router.get('/register/:code', async function (req, res, next) {
  viewInSignupLanguage(req);
  const { code } = req.params;

  try {
    const inviteLink = await InviteLink.get(code);

    if (inviteLink.usedBy) {
      return render.permissionError(req, res, {
        titleKey: 'invite link already used title',
        detailsKey: 'invite link already used'
      });
    } else {
      return sendRegistrationForm(req, res);
    }
  } catch (error) {
    if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError')
      return render.permissionError(req, res, {
        titleKey: 'invite link invalid title',
        detailsKey: 'invite link invalid'
      });
    else
      return next(error);
  }
});

router.post('/signout', function (req, res) {
  req.logout(() => res.redirect('/'));
});

if (!config.requireInviteLinks) {
  router.post('/register', async function (req, res, next) {
    viewInSignupLanguage(req);

    let formInfo = forms.parseSubmission(req, {
      formDef: formDefs.register,
      formKey: 'register'
    });

    if (req.flashHas('pageErrors')) {
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (error) {
        return next(error);
      }
      return;
    }

    try {

      const user = await User.create({
        name: req.body.username,
        password: req.body.password,
        email: req.body.email
      });

      setSignupLanguage(req, res);
      req.login(user, error => {
        if (error) {
          debug.error({ req, error });
        }
        req.flash('siteMessages', res.__('welcome new user', user.displayName));
        returnToPath(req, res);
      });
    } catch (error) {
      req.flashError(error);
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (formError) {
        return next(formError);
      }
      return;
    }
  });
}


router.post('/register/:code', async function (req, res, next) {
  viewInSignupLanguage(req);

  const { code } = req.params;

  try {

    const inviteLink = await InviteLink.get(code);

    if (inviteLink.usedBy)
      return render.permissionError(req, res, {
        titleKey: 'invite link already used title',
        detailsKey: 'invite link already used'
      });

    let formInfo = forms.parseSubmission(req, {
      formDef: formDefs.register,
      formKey: 'register'
    });

    if (req.flashHas('pageErrors')) {
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (error) {
        return next(error);
      }
      return;
    }



    try {
      const user = await User.create({
        name: req.body.username,
        password: req.body.password,
        email: req.body.email
      });

      inviteLink.usedBy = user.id;
      await inviteLink.save();

      setSignupLanguage(req, res);
      req.login(user, error => {
        if (error) {
          debug.error({ req, error });
        }
        req.flash('siteMessages', res.__('welcome new user', user.displayName));
        returnToPath(req, res);
      });
    } catch (error) {
      req.flashError(error);
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (formError) {
        return next(formError);
      }
      return;
    }
  } catch (error) { // Invite link lookup problem
    if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError')
      return render.permissionError(req, res, {
        titleKey: 'invite link invalid title',
        detailsKey: 'invite link invalid'
      });
    else
      return next(error);
  }
});

function sendRegistrationForm(req, res, formInfo) {
  let pageErrors = req.flash('pageErrors');

  const { code } = req.params;
  const body = req.body || {};

  render.template(req, res, 'register', {
    titleKey: 'register',
    pageErrors,
    formValues: formInfo ? formInfo.formValues : undefined,
    questionCaptcha: forms.getQuestionCaptcha('register'),
    illegalUsernameCharactersReadable: User.options.illegalCharsReadable,
    scripts: ['register'],
    inviteCode: code,
    signupLanguage: req.query.signupLanguage || body.signupLanguage
  }, {
    illegalUsernameCharacters: User.options.illegalChars.source
  });
}

// Check for external redirect in returnTo. If present, redirect to /, otherwise
// redirect to returnTo
function returnToPath(req, res) {
  let returnTo = req.body.returnTo;
  // leading slash followed by any non-slash character
  const localPathRegex = new RegExp('^/[^/]');

  if (typeof returnTo != 'string' || !localPathRegex.test(returnTo))
    returnTo = '/';
  res.redirect(returnTo);
}

function redirectBackOrHome(req, res) {
  const backURL = req.get('referer') || '/';
  return res.redirect(backURL);
}

// If the ?signupLanguage query parameter or has been POSTed, and the language
// is valid, show the form in the language (but do not set the cookie yet).
function viewInSignupLanguage(req) {
  const body = req.body || {};
  const signupLanguage = req.query.signupLanguage || body.signupLanguage;
  if (signupLanguage && languages.isValid(signupLanguage))
    i18n.setLocale(req, signupLanguage);
}

// Once we know that the registration is likely to be successful, actually set
// the locale cookie if a signup language was POSTed.
function setSignupLanguage(req, res) {
  const { signupLanguage } = req.body;
  if (signupLanguage && languages.isValid(signupLanguage)) {
    let maxAge = 1000 * 60 * config.sessionCookieDuration; // cookie age: 30 days
    res.cookie('locale', signupLanguage, {
      maxAge,
      httpOnly: true
    });
  }
}
export default router;
