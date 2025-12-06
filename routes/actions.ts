import config from 'config';
import type { Express } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import i18n from 'i18n';
import isUUID from 'is-uuid';
import passport from 'passport';
import type { ParsedQs } from 'qs';
import { z } from 'zod';
import { mlString } from '../dal/index.ts';
import type { MultilingualString } from '../dal/lib/ml-string.ts';
import languages from '../locales/languages.ts';
import AccountRequest from '../models/account-request.ts';
import InviteLink, {
  type InviteLinkInstance,
  type InviteLinkModel as InviteLinkModelConstructor,
} from '../models/invite-link.ts';
import type { AccountRequestInstance } from '../models/manifests/account-request.ts';
import { type UserView, userOptions } from '../models/manifests/user.ts';
import PasswordResetToken from '../models/password-reset-token.ts';
import Team, { type TeamInstance } from '../models/team.ts';
import TeamJoinRequest, { type TeamJoinRequestInstance } from '../models/team-join-request.ts';
import TeamSlug from '../models/team-slug.ts';
import User from '../models/user.ts';
import search from '../search.ts';
import type { HandlerNext, HandlerRequest, HandlerResponse } from '../types/http/handlers.ts';
import debug from '../util/debug.ts';
import {
  formatMailgunError,
  sendAccountRequestApproval,
  sendAccountRequestNotification,
  sendAccountRequestRejection,
  sendPasswordResetEmail,
} from '../util/email.ts';
import actionHandler from './handlers/action-handler.ts';
import signinRequiredRoute from './handlers/signin-required-route.ts';
import forms from './helpers/forms.ts';
import render from './helpers/render.ts';
import { flashZodIssues, formatZodIssueMessage } from './helpers/zod-flash.ts';
import zodForms from './helpers/zod-forms.ts';

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
  plannedReviews?: string;
  languages?: string;
  aboutLinks?: string;
  termsAccepted?: string;
  requestId?: string;
  action?: string;
  rejectionReason?: string;
  [key: string]: string | string[] | boolean | undefined;
};

type ActionsRequestQuery = ParsedQs & {
  query?: string | string[];
  signupLanguage?: string | string[];
};

const router = Router();
const InviteLinkModel: InviteLinkModelConstructor = InviteLink;
type CreateUserPayload = Parameters<typeof User.create>[0];

function getPasswordResetCooldownHours(): number {
  return config.get<number>('passwordReset.cooldownHours') ?? 3;
}

function renderPasswordResetRequested(
  req: ActionsRequest,
  res: ActionsResponse,
  requestedEmail?: string
) {
  const emailParam = requestedEmail ?? '';
  render.template(req, res, 'forgot-password', {
    titleKey: 'password reset requested',
    requestComplete: true,
    requestedEmail: emailParam,
    cooldownHours: getPasswordResetCooldownHours(),
  });
}

const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.get<number>('passwordReset.rateLimitPerIP') ?? 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req: ActionsRequest, res: ActionsResponse) {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email : undefined;
    debug.util(
      `Password reset request blocked by IP rate limit: ip=${req.ip}${
        rawEmail ? ` email=${rawEmail}` : ''
      }`
    );
    renderPasswordResetRequested(req, res, rawEmail);
  },
});

const accountRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler(req: ActionsRequest, res: ActionsResponse) {
    viewInSignupLanguage(req);
    req.flash('pageErrors', res.__('account request rate limit exceeded'));
    return res.redirect('/actions/request-account');
  },
});

const buildRegisterSchema = (req: ActionsRequest) =>
  z
    .object({
      _csrf: z.string().min(1, req.__('need _csrf')),
      username: z.string().min(1, req.__('need username')),
      password: z.string().min(1, req.__('need password')),
      email: z
        .string()
        .optional()
        .transform(value => (value === '' ? undefined : value)),
      returnTo: z.string().optional(),
      signupLanguage: z.string().optional(),
    })
    .strict()
    .merge(zodForms.createCaptchaSchema('register', req.__.bind(req)));

type RegisterForm = z.infer<ReturnType<typeof buildRegisterSchema>>;
type RegisterFormValues = Partial<
  Pick<RegisterForm, 'username' | 'email' | 'returnTo' | 'signupLanguage'>
>;

const accountRequestSchema = (req: ActionsRequest) =>
  z.object({
    _csrf: z.string().min(1, req.__('need _csrf')),
    plannedReviews: z.string().trim().min(1, req.__('account request need planned reviews')),
    languages: z.string().trim().min(1, req.__('account request need languages')),
    aboutLinks: z.string().trim().min(1, req.__('account request need about url')),
    email: z.string().trim().min(1, req.__('need email')).email(req.__('invalid email format')),
    // Checkbox is optional in form data (unchecked = not sent), but we require it to be 'on'
    termsAccepted: z
      .string()
      .optional()
      .refine(val => val === 'on', req.__('must accept terms'))
      .transform(() => true),
  });

type AccountRequestForm = z.infer<ReturnType<typeof accountRequestSchema>>;
type AccountRequestValues = Partial<
  Pick<
    AccountRequestForm,
    'plannedReviews' | 'languages' | 'aboutLinks' | 'email' | 'termsAccepted'
  >
>;

const extractRegisterFormValues = (
  data?: Partial<RegisterForm> | ActionsRequestBody
): RegisterFormValues | undefined => {
  if (!data) return undefined;
  return {
    username: typeof data.username === 'string' ? data.username : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    returnTo: typeof data.returnTo === 'string' ? data.returnTo : undefined,
    signupLanguage: typeof data.signupLanguage === 'string' ? data.signupLanguage : undefined,
  };
};

const extractAccountRequestValues = (
  data?: Partial<AccountRequestForm> | ActionsRequestBody
): AccountRequestValues | undefined => {
  if (!data) return undefined;
  return {
    plannedReviews: typeof data.plannedReviews === 'string' ? data.plannedReviews : undefined,
    languages: typeof data.languages === 'string' ? data.languages : undefined,
    aboutLinks: typeof data.aboutLinks === 'string' ? data.aboutLinks : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    termsAccepted: data.termsAccepted === 'on' || data.termsAccepted === true,
  };
};

function isAccountRequestFeatureEnabled(): boolean {
  const enabled = config.has('accountRequests')
    ? (config.get<{ enabled?: boolean }>('accountRequests')?.enabled ?? false)
    : false;
  const emailEnabled = config.has('email.enabled')
    ? Boolean(config.get<boolean>('email.enabled'))
    : false;
  return Boolean(enabled && emailEnabled && config.requireInviteLinks);
}

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
    const [pendingInviteLinks, usedInviteLinks, allAccountRequestLinks]: [
      InviteLinkInstance[],
      InviteLinkInstance[],
      InviteLinkInstance[],
    ] = await Promise.all([
      InviteLinkModel.getAvailable(user),
      InviteLinkModel.getUsed(user),
      InviteLinkModel.getAccountRequestLinks(user),
    ]);

    // Split account request links into pending and used
    const accountRequestLinks = {
      pendingLinks: allAccountRequestLinks.filter(link => !link.usedBy),
      usedLinks: allAccountRequestLinks.filter(link => link.usedBy),
    };

    render.template(req, res, 'invite', {
      titleKey: res.locals.titleKey,
      invitePage: true, // to tell template not to show call-to-action again
      pendingInviteLinks,
      usedInviteLinks,
      accountRequestLinks,
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

const forgotPasswordSchema = z
  .object({
    _csrf: z.string().min(1),
    email: z.string().email().max(128),
  })
  .strict();

router.get('/forgot-password', (req: ActionsRequest, res: ActionsResponse) => {
  const pageErrors = req.flash('pageErrors');
  render.template(req, res, 'forgot-password', {
    titleKey: 'forgot password',
    cooldownHours: getPasswordResetCooldownHours(),
    requestComplete: false,
    pageErrors,
  });
});

router.post(
  '/forgot-password',
  passwordResetLimiter,
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    try {
      const formData = forgotPasswordSchema.parse(req.body);
      const email = formData.email.trim().toLowerCase();

      const cooldownHours = getPasswordResetCooldownHours();
      const hasRecent = await PasswordResetToken.hasRecentRequest(email, cooldownHours);
      if (hasRecent) {
        debug.util(`Password reset email skipped due to cooldown for ${email}`);
        renderPasswordResetRequested(req, res, email);
        return;
      }

      const users = await User.filterWhere({
        email,
        password: User.ops.neq(null),
      }).run();

      if (users.length > 0) {
        for (const user of users) {
          const token = await PasswordResetToken.create(
            user.id as string,
            email,
            req.ip as string | undefined
          );

          const language = typeof req.language === 'string' ? req.language : req.locale;
          sendPasswordResetEmail(email, token.id as string, language).catch(error => {
            debug.error(`Failed to send password reset email: ${formatMailgunError(error)}`);
          });
        }
      } else {
        debug.util(`Password reset email skipped because no user found for ${email}`);
      }

      renderPasswordResetRequested(req, res, email);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const email = typeof req.body.email === 'string' ? req.body.email : '';
        req.flash('pageErrors', req.__('invalid email format', email));
        return res.redirect('/forgot-password');
      }
      next(error);
    }
  }
);

const resetPasswordSchema = z
  .object({
    _csrf: z.string().min(1),
    password: z.string().min(userOptions.minPasswordLength),
  })
  .strict();

router.get('/reset-password/:token', async (req: ActionsRequest, res: ActionsResponse) => {
  const tokenID = req.params.token;

  if (!tokenID || !isUUID.v4(tokenID)) {
    return render.template(req, res, 'reset-password', {
      titleKey: 'reset password',
      tokenValid: false,
    });
  }

  const token = await PasswordResetToken.findByID(tokenID);
  const tokenValid = !!token && token.isValid();

  render.template(req, res, 'reset-password', {
    titleKey: 'reset password',
    token: tokenID,
    tokenValid,
  });
});

router.post(
  '/reset-password/:token',
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    const tokenID = req.params.token;

    try {
      const formData = resetPasswordSchema.parse(req.body);

      if (!tokenID || !isUUID.v4(tokenID)) {
        req.flash('pageErrors', req.__('invalid reset token'));
        return res.redirect(`/reset-password/${tokenID}`);
      }

      const token = await PasswordResetToken.findByID(tokenID);
      if (!token || !token.isValid()) {
        req.flash('pageErrors', req.__('invalid reset token'));
        return res.redirect(`/reset-password/${tokenID}`);
      }

      const user = await token.getUser();
      if (!user) {
        debug.error(`Reset token ${tokenID} references non-existent user ${token.userID}`);
        req.flash('pageErrors', req.__('invalid reset token'));
        return res.redirect(`/reset-password/${tokenID}`);
      }

      await user.setPassword(formData.password);
      await user.save({ updateSensitive: ['password'] });

      await token.markAsUsed();
      await PasswordResetToken.invalidateAllForUser(user.id);

      req.login(user as Express.User, error => {
        if (error) {
          debug.error('Failed to log in user after password reset:', error);
          req.flash('siteErrors', req.__('unknown error'));
          return res.redirect('/signin');
        }

        req.flash('siteMessages', req.__('password reset success'));
        return res.redirect('/');
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.some(issue => issue.path.includes('password'))
          ? req.__('password too short', String(userOptions.minPasswordLength))
          : req.__('correct errors');
        req.flash('pageErrors', message);
        return res.redirect(`/reset-password/${tokenID}`);
      }
      next(error);
    }
  }
);

router.get(
  '/actions/request-account',
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    viewInSignupLanguage(req);

    if (!isAccountRequestFeatureEnabled()) {
      return render.permissionError(req, res, {
        titleKey: 'request account',
        detailsKey: 'account requests disabled',
      });
    }

    if (!config.requireInviteLinks) {
      return res.redirect('/register');
    }

    try {
      await renderAccountRequestForm(req, res, extractAccountRequestValues(req.body));
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/actions/request-account',
  accountRequestLimiter,
  async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
    viewInSignupLanguage(req);

    if (!isAccountRequestFeatureEnabled()) {
      return render.permissionError(req, res, {
        titleKey: 'request account',
        detailsKey: 'account requests disabled',
      });
    }

    if (!config.requireInviteLinks) {
      return res.redirect('/register');
    }

    const parseResult = accountRequestSchema(req).safeParse(req.body);

    if (!parseResult.success) {
      flashZodIssues(req, parseResult.error.issues, issue => formatZodIssueMessage(req, issue));
      return renderAccountRequestForm(req, res, extractAccountRequestValues(req.body));
    }

    const formData = parseResult.data;
    const email = formData.email.trim().toLowerCase();
    const configValues = config.get('accountRequests') as {
      rateLimitPerIP?: number;
      rateLimitWindowHours?: number;
      emailCooldownHours?: number;
    };

    try {
      const maxRequests = configValues.rateLimitPerIP ?? 3;
      const windowHours = configValues.rateLimitWindowHours ?? 24;
      const ipLimitExceeded = await AccountRequest.checkIPRateLimit(
        req.ip,
        maxRequests,
        windowHours
      );

      if (ipLimitExceeded) {
        req.flash('pageErrors', res.__('account request rate limit exceeded'));
        return renderAccountRequestForm(req, res, extractAccountRequestValues(req.body));
      }

      const cooldownHours = configValues.emailCooldownHours ?? 24;
      const hasRecent = await AccountRequest.hasRecentRequest(email, cooldownHours);

      if (hasRecent) {
        req.flash('pageErrors', res.__('account request already pending'));
        return renderAccountRequestForm(req, res, extractAccountRequestValues(req.body));
      }

      const language = req.language || 'en';

      const createdRequest = await AccountRequest.createRequest({
        plannedReviews: formData.plannedReviews.trim(),
        languages: formData.languages.trim(),
        aboutLinks: formData.aboutLinks.trim(),
        email,
        language,
        termsAccepted: formData.termsAccepted,
        ipAddress: req.ip,
      });
      // Moderator notification emails must be in English since we don't store
      // language preferences in the database (only in cookies)
      sendAccountRequestNotification(
        {
          email: createdRequest.email,
          plannedReviews: createdRequest.plannedReviews,
          languages: createdRequest.languages,
          aboutLinks: createdRequest.aboutLinks,
        },
        'en'
      ).catch(error => {
        debug.error(`Failed to send account request notification: ${formatMailgunError(error)}`);
      });

      req.flash('siteMessages', res.__('account request submitted'));
      return res.redirect('/');
    } catch (error) {
      next(error);
    }
  }
);

router.get('/new/user', (req: ActionsRequest, res: ActionsResponse) => {
  res.redirect('/register');
});

router.get('/register', async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
  viewInSignupLanguage(req);
  if (config.requireInviteLinks) {
    if (isAccountRequestFeatureEnabled()) {
      return res.redirect('/actions/request-account');
    }
    return render.template(req, res, 'invite-needed', {
      titleKey: 'register',
    });
  } else
    try {
      await sendRegistrationForm(req, res);
    } catch (error) {
      next(error);
    }
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
        return await sendRegistrationForm(req, res);
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

    const registerResult = buildRegisterSchema(req).safeParse(req.body);
    if (!registerResult.success) {
      flashZodIssues(req, registerResult.error.issues, issue => formatZodIssueMessage(req, issue));
      try {
        await sendRegistrationForm(req, res, extractRegisterFormValues(req.body));
      } catch (error) {
        return next(error);
      }
      return;
    }

    const formValues: RegisterForm = registerResult.data;

    try {
      const userPayload: CreateUserPayload = {
        name: formValues.username,
        password: formValues.password,
        email: formValues.email,
      };
      const user = await User.create(userPayload);

      const joinTeamsParam = req.body['join-teams'];
      if (typeof joinTeamsParam === 'string' || Array.isArray(joinTeamsParam)) {
        await joinTeams(req, user as Express.User, joinTeamsParam);
      }

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
        await sendRegistrationForm(req, res, extractRegisterFormValues(formValues));
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

      const registerResult = buildRegisterSchema(req).safeParse(req.body);
      if (!registerResult.success) {
        flashZodIssues(req, registerResult.error.issues, issue =>
          formatZodIssueMessage(req, issue)
        );
        try {
          await sendRegistrationForm(req, res, extractRegisterFormValues(req.body));
        } catch (error) {
          return next(error);
        }
        return;
      }

      const formValues: RegisterForm = registerResult.data;

      try {
        const userPayload: CreateUserPayload = {
          name: formValues.username,
          password: formValues.password,
          email: formValues.email,
        };
        const user = await User.create(userPayload);

        inviteLink.usedBy = user.id;
        await inviteLink.save();

        const joinTeamsParam = req.body['join-teams'];
        if (typeof joinTeamsParam === 'string' || Array.isArray(joinTeamsParam)) {
          await joinTeams(req, user as Express.User, joinTeamsParam);
        }

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
          await sendRegistrationForm(req, res, extractRegisterFormValues(formValues));
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

router.get(
  '/actions/manage-requests',
  signinRequiredRoute(
    'manage account requests',
    async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
      if (!req.user?.isSiteModerator) {
        return render.permissionError(req, res, {
          titleKey: 'manage account requests',
          detailsKey: 'must be site moderator',
        });
      }

      if (!isAccountRequestFeatureEnabled()) {
        return render.permissionError(req, res, {
          titleKey: 'manage account requests',
          detailsKey: 'account requests disabled',
        });
      }

      try {
        const pendingRequests = await AccountRequest.getPending();
        const moderatedRequests = (await AccountRequest.getModerated(100)) as Array<
          AccountRequestInstance & { moderator?: UserView }
        >;

        const moderatorIDs = [
          ...new Set(
            moderatedRequests
              .map(request => request.moderatedBy)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          ),
        ];

        if (moderatorIDs.length > 0) {
          const moderators = await User.fetchView<UserView>('publicProfile', {
            configure(builder) {
              builder.whereIn('id', moderatorIDs, { cast: 'uuid[]' });
            },
          });
          const moderatorMap = new Map<string, UserView>();
          moderators.forEach(user => {
            if (user.id) {
              moderatorMap.set(user.id, user);
            }
          });

          moderatedRequests.forEach(request => {
            if (request.moderatedBy && moderatorMap.has(request.moderatedBy)) {
              request.moderator = moderatorMap.get(request.moderatedBy);
            }
          });
        }

        render.template(req, res, 'manage-account-requests', {
          titleKey: 'manage account requests',
          pendingRequests,
          moderatedRequests,
          pageErrors: req.flash('pageErrors'),
          pageMessages: req.flash('pageMessages'),
        });
      } catch (error) {
        next(error);
      }
    }
  )
);

router.post(
  '/actions/manage-requests',
  signinRequiredRoute(
    'manage account requests',
    async (req: ActionsRequest, res: ActionsResponse, next: HandlerNext) => {
      if (!req.user?.isSiteModerator) {
        return render.permissionError(req, res, {
          titleKey: 'manage account requests',
          detailsKey: 'must be site moderator',
        });
      }

      if (!isAccountRequestFeatureEnabled()) {
        return render.permissionError(req, res, {
          titleKey: 'manage account requests',
          detailsKey: 'account requests disabled',
        });
      }

      const requestId = typeof req.body.requestId === 'string' ? req.body.requestId.trim() : '';
      const action = typeof req.body.action === 'string' ? req.body.action : '';
      const rejectionReasonRaw =
        typeof req.body.rejectionReason === 'string' ? req.body.rejectionReason : '';

      if (!requestId || !isUUID.v4(requestId) || (action !== 'approve' && action !== 'reject')) {
        req.flash('pageErrors', res.__('invalid account request action'));
        return res.redirect('/actions/manage-requests');
      }

      try {
        const accountRequest = (await AccountRequest.filterWhere({ id: requestId })
          .includeSensitive(['email'])
          .first()) as AccountRequestInstance | null;

        if (!accountRequest) {
          req.flash('pageErrors', res.__('invalid account request action'));
          return res.redirect('/actions/manage-requests');
        }

        if (accountRequest.status !== 'pending') {
          req.flash('pageErrors', res.__('request already processed'));
          return res.redirect('/actions/manage-requests');
        }

        if (action === 'approve') {
          const inviteLink: InviteLinkInstance = new InviteLinkModel({});
          inviteLink.createdOn = new Date();
          inviteLink.createdBy = req.user.id;
          await inviteLink.save();

          accountRequest.status = 'approved';
          accountRequest.moderatedBy = req.user.id;
          accountRequest.moderatedAt = new Date();
          accountRequest.inviteLinkID = inviteLink.id;
          accountRequest.rejectionReason = undefined;

          await accountRequest.save();

          const language = accountRequest.language || 'en';
          sendAccountRequestApproval(accountRequest.email, inviteLink.id, language).catch(error => {
            debug.error(`Failed to send approval email: ${formatMailgunError(error)}`);
          });

          req.flash('siteMessages', res.__('account request approved'));
        } else if (action === 'reject') {
          accountRequest.status = 'rejected';
          accountRequest.moderatedBy = req.user.id;
          accountRequest.moderatedAt = new Date();

          const rejectionReason = rejectionReasonRaw.trim();
          accountRequest.rejectionReason = rejectionReason || undefined;

          await accountRequest.save();

          if (rejectionReason) {
            const language = accountRequest.language || 'en';
            sendAccountRequestRejection(accountRequest.email, rejectionReason, language).catch(
              error => {
                debug.error(`Failed to send rejection email: ${formatMailgunError(error)}`);
              }
            );
          }

          req.flash('siteMessages', res.__('account request rejected'));
        }

        return res.redirect('/actions/manage-requests');
      } catch (error) {
        next(error);
      }
    }
  )
);

async function sendRegistrationForm(
  req: ActionsRequest,
  res: ActionsResponse,
  formValues?: RegisterFormValues
) {
  const pageErrors = req.flash('pageErrors');

  const { code } = req.params;
  const body: ActionsRequestBody = req.body ?? {};

  const rawTeams = req.query.team;
  const teamSlugs = Array.isArray(rawTeams)
    ? rawTeams.map(String)
    : typeof rawTeams === 'string'
      ? [rawTeams]
      : [];

  const teamsToJoin: Array<{ slug: string; name: string; motto?: string }> = [];

  if (teamSlugs.length > 0) {
    const locale = req.locale;
    for (const slugName of teamSlugs) {
      const slug = await TeamSlug.getByName(slugName);
      if (slug && slug.teamID) {
        const team = await Team.filterWhere({ id: slug.teamID }).first();
        if (team) {
          const resolvedName = mlString.resolve(locale, team.name);
          if (resolvedName && resolvedName.str) {
            const resolvedMotto = mlString.resolve(locale, team.motto as MultilingualString);
            teamsToJoin.push({
              slug: slugName,
              name: resolvedName.str,
              motto: resolvedMotto?.str,
            });
          }
        }
      }
    }
  }

  render.template(
    req,
    res,
    'register',
    {
      titleKey: 'register',
      pageErrors,
      formValues,
      questionCaptcha: forms.getQuestionCaptcha('register'),
      illegalUsernameCharactersReadable: User.options.illegalCharsReadable,
      scripts: ['register'],
      inviteCode: code,
      signupLanguage: req.query.signupLanguage || body.signupLanguage,
      teamsToJoin,
    },
    {
      illegalUsernameCharacters: User.options.illegalChars.source,
    }
  );
}

async function renderAccountRequestForm(
  req: ActionsRequest,
  res: ActionsResponse,
  formValues?: AccountRequestValues
) {
  const pageErrors = req.flash('pageErrors');

  render.template(req, res, 'request-account', {
    titleKey: 'request account',
    pageErrors,
    formValues,
    deferPageHeader: true,
  });
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

async function joinTeams(
  req: ActionsRequest,
  user: Express.User,
  teamsParam: string | string[] | undefined
) {
  if (!teamsParam) return;
  const teamSlugs = Array.isArray(teamsParam) ? teamsParam : [teamsParam];
  const teamSlugsUnique = [...new Set(teamSlugs)];

  const teamsToJoin: TeamInstance[] = [];
  const joinRequests: TeamJoinRequestInstance[] = [];

  for (const slugName of teamSlugsUnique) {
    if (typeof slugName !== 'string') continue;
    const slug = await TeamSlug.getByName(slugName);
    if (slug && slug.teamID) {
      const team = await Team.filterWhere({ id: slug.teamID }).first();
      if (team) {
        if (team.modApprovalToJoin) {
          const teamJoinRequest = new TeamJoinRequest({
            teamID: team.id,
            userID: user.id,
            requestMessage: req.__('team signup requested'),
            requestDate: new Date(),
            status: 'pending',
          });
          joinRequests.push(teamJoinRequest);
        } else {
          teamsToJoin.push(team);
        }
      }
    }
  }

  if (teamsToJoin.length > 0) {
    const userWithTeams = await User.getWithTeams(user.id);
    if (userWithTeams) {
      const currentTeams = userWithTeams.teams || [];
      const newTeams = [...currentTeams];
      for (const t of teamsToJoin) {
        if (!newTeams.find(nt => nt.id === t.id)) {
          newTeams.push(t);
        }
      }
      userWithTeams.teams = newTeams;
      await userWithTeams.saveAll();
    }
  }

  for (const request of joinRequests) {
    await request.save();
  }
}

export default router;
