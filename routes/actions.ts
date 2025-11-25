import config from 'config';
import type { Express } from 'express';
import { Router } from 'express';
import i18n from 'i18n';
import passport from 'passport';
import type { ParsedQs } from 'qs';
import languages from '../locales/languages.ts';
import InviteLink, {
  type InviteLinkInstance,
  type InviteLinkModel as InviteLinkModelConstructor,
} from '../models/invite-link.ts';
import User from '../models/user.ts';
import search from '../search.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import debug from '../util/debug.ts';
import actionHandler from './handlers/action-handler.ts';
import signinRequiredRoute from './handlers/signin-required-route.ts';
import forms, { type FormField } from './helpers/forms.ts';
import render from './helpers/render.ts';

type ActionsRequest = HandlerRequest<
  Record<string, string>,
  unknown,
  ActionsRequestBody,
  ActionsRequestQuery
>;
type ActionsResponse = HandlerResponse;

type ActionsRequestBody = {
  username?: string;
  password?: string;
  email?: string;
  returnTo?: string;
  signupLanguage?: string;
  lang?: string;
  'redirect-to'?: string;
  'has-language-notice'?: string | boolean;
  [key: string]: string | boolean | undefined;
};

type ActionsRequestQuery = ParsedQs & {
  query?: string | string[];
  signupLanguage?: string | string[];
};

const router = Router();
const InviteLinkModel: InviteLinkModelConstructor = InviteLink;
type CreateUserPayload = Parameters<typeof User.create>[0];

const formDefs: Record<string, FormField[]> = {
  register: [
    {
      name: 'username',
      required: true,
    },
    {
      name: 'password',
      required: true,
    },
    {
      name: 'email',
      required: false,
    },
    {
      name: 'returnTo',
      required: false,
    },
    {
      name: 'signupLanguage',
      required: false,
    },
  ],
};

router.get('/actions/search', (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
  const queryValue = req.query.query;
  const rawQuery =
    typeof queryValue === 'string'
      ? queryValue
      : Array.isArray(queryValue)
        ? String(queryValue[0] ?? '')
        : '';
  const query = rawQuery.trim();
  if (query) {
    const localeCode = languages.isValid(req.locale) ? (req.locale as LibReviews.LocaleCode) : 'en';
    Promise.all([search.searchThings(query, localeCode), search.searchReviews(query, localeCode)])
      .then(([thingsResult, reviewsResult]) => {
        let labelMatches = thingsResult.hits.hits;
        let textMatches = search.filterDuplicateInnerHighlights(reviewsResult.hits.hits, 'review');
        const noMatches = !labelMatches.length && !textMatches.length;

        render.template(req, res, 'search', {
          titleKey: 'search results',
          noMatches,
          labelMatches,
          textMatches,
          query,
          showHelp: noMatches,
          deferPageHeader: true,
        });
      })
      .catch(next);
  } else {
    render.template(req, res, 'search', {
      titleKey: 'search lib.reviews',
      showHelp: true,
      deferPageHeader: true,
    });
  }
});

router.get('/actions/invite', signinRequiredRoute('invite users', renderInviteLinkPage));

router.post(
  '/actions/invite',
  signinRequiredRoute(
    'invite users',
    async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
      try {
        const user = req.user;
        if (!user) {
          next(new Error('User required to generate invite links.'));
          return;
        }

        if (!user.inviteLinkCount) {
          req.flash('pageErrors', res.__('out of links'));
          return renderInviteLinkPage(req, res, next);
        }

        const inviteLink: InviteLinkInstance = new InviteLinkModel({});
        inviteLink.createdOn = new Date();
        inviteLink.createdBy = user.id;
        const saveInvitePromise = inviteLink.save();

        const updated = await User.filterWhere({ id: user.id }).decrement('inviteLinkCount', {
          by: 1,
          returning: ['inviteLinkCount'],
        });

        if (updated.rows[0]?.inviteLinkCount !== undefined) {
          user.inviteLinkCount = updated.rows[0].inviteLinkCount as number;
        }

        await saveInvitePromise;

        req.flash('pageMessages', res.__('link generated'));
        return renderInviteLinkPage(req, res, next);
      } catch (error) {
        next(error);
      }
    }
  )
);

/**
 * Render the invite link management view, including unused and used links.
 *
 * @param req
 *  Request containing the authenticated user
 * @param res
 *  Response used to render the invite template
 * @param next
 *  Express callback for error propagation
 */
async function renderInviteLinkPage(req: ActionsRequest, res: ActionsResponse, next: HandlerNext) {
  try {
    const user = req.user;
    if (!user) {
      next(new Error('User required to view invite links.'));
      return;
    }
    const [pendingInviteLinks, usedInviteLinks]: [InviteLinkInstance[], InviteLinkInstance[]] =
      await Promise.all([InviteLinkModel.getAvailable(user), InviteLinkModel.getUsed(user)]);

    render.template(req, res, 'invite', {
      titleKey: res.locals.titleKey,
      invitePage: true, // to tell template not to show call-to-action again
      pendingInviteLinks,
      usedInviteLinks,
      pageErrors: req.flash('pageErrors'),
      pageMessages: req.flash('pageMessages'),
    });
  } catch (error) {
    next(error);
  }
}

router.post('/actions/suppress-notice', actionHandler.suppressNotice);

router.post('/actions/change-language', (req: ActionsRequest, res: ActionsResponse) => {
  const maxAge = 1000 * 60 * config.sessionCookieDuration; // cookie age: 30 days
  const lang = typeof req.body?.lang === 'string' ? req.body.lang : '';
  const redirectTo =
    typeof req.body?.['redirect-to'] === 'string' ? req.body['redirect-to'] : undefined;

  const hasLanguageNotice = Boolean(req.body?.['has-language-notice']);

  if (!languages.isValid(lang)) {
    req.flash('siteErrors', req.__('invalid language'));
    if (redirectTo) return res.redirect(redirectTo);
    else return redirectBackOrHome(req, res);
  }

  res.cookie('locale', lang, {
    maxAge,
    httpOnly: true,
  });
  i18n.setLocale(req, lang);

  // Don't show on pages with language notices on them, to avoid message overkill.
  if (!hasLanguageNotice) req.flash('siteMessages', req.__('notification language-changed'));

  if (redirectTo) res.redirect(redirectTo);
  else redirectBackOrHome(req, res);
});

// Below actions have shorter names for convenience

router.get('/signin', (req: ActionsRequest, res: ActionsResponse) => {
  const pageErrors = req.flash('pageErrors');
  render.template(req, res, 'signin', {
    titleKey: 'sign in',
    pageErrors,
  });
});

router.post('/signin', (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
  if (!req.body.username || !req.body.password) {
    if (!req.body.username) req.flash('pageErrors', req.__('need username'));
    if (!req.body.password) req.flash('pageErrors', req.__('need password'));
    return res.redirect('/signin');
  }

  passport.authenticate('local', (error, user, info) => {
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
    req.login(user, error => {
      if (error) {
        debug.error({ req, error });
        return res.redirect('/signin');
      } else {
        return returnToPath(req, res); // Success
      }
    });
  })(req, res, next);
});

router.get('/new/user', (req: ActionsRequest, res: ActionsResponse) => {
  res.redirect('/register');
});

router.get('/register', (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
  viewInSignupLanguage(req);
  if (config.requireInviteLinks)
    return render.template(req, res, 'invite-needed', {
      titleKey: 'register',
    });
  else return sendRegistrationForm(req, res);
});

router.get(
  '/register/:code',
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    viewInSignupLanguage(req);
    const { code } = req.params;

    try {
      const inviteLink: InviteLinkInstance = await InviteLinkModel.get(code);

      if (inviteLink.usedBy) {
        return render.permissionError(req, res, {
          titleKey: 'invite link already used title',
          detailsKey: 'invite link already used',
        });
      } else {
        return sendRegistrationForm(req, res);
      }
    } catch (error) {
      if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError')
        return render.permissionError(req, res, {
          titleKey: 'invite link invalid title',
          detailsKey: 'invite link invalid',
        });
      else return next(error);
    }
  }
);

router.post('/signout', (req: ActionsRequest, res: ActionsResponse) => {
  req.logout(() => res.redirect('/'));
});

if (!config.requireInviteLinks) {
  router.post('/register', async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    viewInSignupLanguage(req);

    let formInfo = forms.parseSubmission(req, {
      formDef: formDefs.register,
      formKey: 'register',
    });

    if (req.flashHas?.('pageErrors')) {
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (error) {
        return next(error);
      }
      return;
    }

    try {
      const userPayload: CreateUserPayload = {
        name: req.body.username as string,
        password: req.body.password as string,
        email: typeof req.body.email === 'string' ? req.body.email : undefined,
      };
      const user = await User.create(userPayload);

      setSignupLanguage(req, res);
      req.login(user as Express.User, error => {
        if (error) {
          debug.error({ req, error });
        }
        req.flash('siteMessages', res.__('welcome new user', user.displayName));
        returnToPath(req, res);
      });
    } catch (error) {
      req.flashError?.(error);
      try {
        await sendRegistrationForm(req, res, formInfo);
      } catch (formError) {
        return next(formError);
      }
      return;
    }
  });
}

router.post(
  '/register/:code',
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    viewInSignupLanguage(req);

    const { code } = req.params;

    try {
      const inviteLink: InviteLinkInstance = await InviteLinkModel.get(code);

      if (inviteLink.usedBy)
        return render.permissionError(req, res, {
          titleKey: 'invite link already used title',
          detailsKey: 'invite link already used',
        });

      let formInfo = forms.parseSubmission(req, {
        formDef: formDefs.register,
        formKey: 'register',
      });

      if (req.flashHas?.('pageErrors')) {
        try {
          await sendRegistrationForm(req, res, formInfo);
        } catch (error) {
          return next(error);
        }
        return;
      }

      try {
        const userPayload: CreateUserPayload = {
          name: req.body.username as string,
          password: req.body.password as string,
          email: typeof req.body.email === 'string' ? req.body.email : undefined,
        };
        const user = await User.create(userPayload);

        inviteLink.usedBy = user.id;
        await inviteLink.save();

        setSignupLanguage(req, res);
        req.login(user as Express.User, error => {
          if (error) {
            debug.error({ req, error });
          }
          req.flash('siteMessages', res.__('welcome new user', user.displayName));
          returnToPath(req, res);
        });
      } catch (error) {
        req.flashError?.(error);
        try {
          await sendRegistrationForm(req, res, formInfo);
        } catch (formError) {
          return next(formError);
        }
        return;
      }
    } catch (error) {
      // Invite link lookup problem
      if (error.name === 'DocumentNotFound' || error.name === 'DocumentNotFoundError')
        return render.permissionError(req, res, {
          titleKey: 'invite link invalid title',
          detailsKey: 'invite link invalid',
        });
      else return next(error);
    }
  }
);

function sendRegistrationForm(
  req: ActionsRequest,
  res: ActionsResponse,
  formInfo?: ReturnType<typeof forms.parseSubmission>
) {
  const pageErrors = req.flash('pageErrors');

  const { code } = req.params;
  const body: ActionsRequestBody = req.body ?? {};

  render.template(
    req,
    res,
    'register',
    {
      titleKey: 'register',
      pageErrors,
      formValues: formInfo ? formInfo.formValues : undefined,
      questionCaptcha: forms.getQuestionCaptcha('register'),
      illegalUsernameCharactersReadable: User.options.illegalCharsReadable,
      scripts: ['register'],
      inviteCode: code,
      signupLanguage: req.query.signupLanguage || body.signupLanguage,
    },
    {
      illegalUsernameCharacters: User.options.illegalChars.source,
    }
  );
}

// Check for external redirect in returnTo. If present, redirect to /, otherwise
// redirect to returnTo
function returnToPath(req: ActionsRequest, res: ActionsResponse) {
  let returnTo = typeof req.body.returnTo === 'string' ? req.body.returnTo : '';
  // leading slash followed by any non-slash character
  const localPathRegex = /^\/[^\/]/;

  if (typeof returnTo != 'string' || !localPathRegex.test(returnTo)) returnTo = '/';
  res.redirect(returnTo);
}

function redirectBackOrHome(req: ActionsRequest, res: ActionsResponse) {
  const backURL = req.get('referer') || '/';
  return res.redirect(backURL);
}

// If the ?signupLanguage query parameter or has been POSTed, and the language
// is valid, show the form in the language (but do not set the cookie yet).
function viewInSignupLanguage(req: ActionsRequest) {
  const body: ActionsRequestBody = req.body ?? {};
  const signupLanguageQuery = req.query.signupLanguage;
  const signupLanguageBody = body.signupLanguage;
  const signupLanguage =
    typeof signupLanguageQuery === 'string'
      ? signupLanguageQuery
      : typeof signupLanguageBody === 'string'
        ? signupLanguageBody
        : undefined;
  if (signupLanguage && languages.isValid(signupLanguage)) i18n.setLocale(req, signupLanguage);
}

// Once we know that the registration is likely to be successful, actually set
// the locale cookie if a signup language was POSTed.
function setSignupLanguage(req: ActionsRequest, res: ActionsResponse) {
  const { signupLanguage } = req.body ?? {};
  if (signupLanguage && languages.isValid(signupLanguage)) {
    const maxAge = 1000 * 60 * config.sessionCookieDuration; // cookie age: 30 days
    res.cookie('locale', signupLanguage, {
      maxAge,
      httpOnly: true,
    });
  }
}
export default router;
