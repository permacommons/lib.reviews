/**
 * The main logic for initializing an instance of the lib.reviews Express web
 * application.
 *
 * @namespace App
 */

// External dependencies
import bodyParser from 'body-parser';
import compression from 'compression';
import config from 'config';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import favicon from 'serve-favicon';
import fs from 'node:fs';
import hbs from 'hbs'; // handlebars templating
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from 'i18n';
import logger from 'morgan';
import passport from 'passport';
import serveIndex from 'serve-index';
import csp from 'helmet-csp'; // Content security policy
import expressUserAgent from 'express-useragent';

import { csrfSynchronisedProtection } from './util/csrf.js';
import { initializeDAL } from './bootstrap/dal.mjs';

const require = createRequire(import.meta.url);

// Internal dependencies
const hbsUtilsFactory = require('hbs-utils');
const connectPgSimple = require('connect-pg-simple');
const WebHookDispatcher = require('./util/webhooks');
const languages = require('./locales/languages');
const apiHelper = require('./routes/helpers/api');
const flashHelper = require('./routes/helpers/flash');
const ErrorProvider = require('./routes/errors');
const debug = require('./util/debug');
const clientAssets = require('./util/client-assets');
const flashStore = require('./util/flash-store');

// Initialize custom HBS helpers
require('./util/handlebars-helpers.js');

const hbsutils = hbsUtilsFactory(hbs);
const pgSession = connectPgSimple(session);
const expressUserAgentMiddleware = expressUserAgent.express;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let initializedApp;

/**
 * Initialize an instance of the app and provide it when it is ready for use.
 * @returns {Promise<import('express').Express>}
 *  an Express app
 * @memberof App
 */
async function getApp() {
  if (initializedApp)
    return initializedApp;

  // Push promises into this array that need to resolve before the app itself
  // is ready for use
  const asyncJobs = [];

  // Create directories for uploads and deleted files if needed
  asyncJobs.push(...['deleted', 'static/uploads', 'static/downloads'].map(setupDirectory));

const dalPromise = initializeDAL();
asyncJobs.push(dalPromise);

  // Auth setup
  require('./auth');

  // i18n setup
  i18n.configure({
    locales: languages.getValidLanguages(),
    cookie: 'locale',
    defaultLocale: 'en',
    autoReload: process.env.NODE_CONFIG_DISABLE_WATCH !== 'Y',
    updateFiles: false,
    retryInDefaultLocale: true,
    directory: path.join(__dirname, 'locales')
  });

  // express setup
  const app = express();

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));

  asyncJobs.push(new Promise(resolveJob =>
    hbsutils.registerPartials(path.join(__dirname, 'views/partials'), undefined, () => resolveJob())
  ));

  app.set('view engine', 'hbs');

  if (config.forceHTTPS)
    app.use(csp({
      directives: { upgradeInsecureRequests: true }
    }));

  app.use(cookieParser());
  app.use(i18n.init); // Requires cookie parser!
  app.use(expressUserAgentMiddleware()); // expose UA object to req.useragent

  // Get the initialized DAL instance
  const dal = await dalPromise;
  app.locals.dal = dal;

  // Load routes after database is ready
  const { default: reviews } = await import('./routes/reviews.mjs');
  const { default: actions } = await import('./routes/actions.mjs');
  const users = require('./routes/users');
  const { default: teams } = await import('./routes/teams.mjs');
  const pages = require('./routes/pages');
  const files = require('./routes/files');
  const blogPosts = require('./routes/blog-posts');
  const api = require('./routes/api');
  const things = require('./routes/things');
  const apitest = require('./routes/apitest');
  const { stage1Router, stage2Router } = require('./routes/uploads');

  const store = new pgSession({
    pool: dal.pool,
    tableName: 'session'
  });

  app.use(session({
    key: 'libreviews_session',
    resave: true,
    saveUninitialized: true,
    secret: config.get('sessionSecret'),
    cookie: {
      maxAge: config.get('sessionCookieDuration') * 1000 * 60
    },
    store
  }));

  app.use(flashStore);
  app.use(flashHelper);

  app.use(compression());

  app.use(favicon(path.join(__dirname, 'static/img/favicon.ico'))); // not logged

  if (config.get('logger'))
    app.use(logger(config.get('logger')));

  app.use('/static/downloads', serveIndex(path.join(__dirname, 'static/downloads'), {
    icons: true,
    template: path.join(__dirname, 'views/downloads.html')
  }));

  // Cache immutable assets for one year
  app.use('/static', (req, res, next) => {
    if (/.*\.(svg|jpg|webm|gif|png|ogg|tgz|zip|woff2)$/.test(req.path))
      res.set('Cache-Control', 'public, max-age=31536000');
    return next();
  });

  app.use('/static', express.static(path.join(__dirname, 'static')));

  if (process.env.NODE_ENV !== 'production') {
    // Convenience endpoint: expose manifest for inspection during development
    app.get('/assets/manifest.json', (req, res, next) => {
      try {
        res.set('Cache-Control', 'no-store');
        res.json(clientAssets.getManifest());
      } catch (error) {
        next(error);
      }
    });
  }

  app.use('/assets', express.static(path.join(__dirname, 'build', 'vite'), {
    fallthrough: true,
    maxAge: '1y'
  }));

  if (process.env.NODE_ENV !== 'production' && process.env.LIBREVIEWS_VITE_DEV_SERVER !== 'off') {
    const viteConfigPath = path.join(__dirname, 'vite.config.mjs');
    const createViteServer = async() => {
      const { createServer } = await import('vite');
      return createServer({
        configFile: viteConfigPath,
        server: {
          middlewareMode: true,
          watch: {
            usePolling: process.env.VITE_USE_POLLING === '1'
          }
        },
        appType: 'custom'
      });
    };

    const viteServer = await createViteServer();
    app.use(viteServer.middlewares);
    app.locals.vite = viteServer;
  }

  app.use('/robots.txt', (req, res) => {
    res.type('text');
    res.send('User-agent: *\nDisallow: /api/\n');
  });

  // Initialize Passport and restore authentication state, if any, from the session.
  app.use(passport.initialize());
  app.use(passport.session());

  // API requests do not require CSRF tokens (hence declared before CSRF middleware),
  // but session-authenticated POST requests do require the X-Requested-With header to be set,
  // which ensures they're subject to CORS rules. This middleware also sets req.isAPI to true.
  app.use('/api', apiHelper.prepareRequest);

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({
    extended: false
  }));

  const errorProvider = new ErrorProvider(app);

  if (config.maintenanceMode) {
    app.use('/', errorProvider.maintenanceMode);
  }

  // ?uselang=xx changes language temporarily if xx is a valid, different code
  app.use('/', (req, res, next) => {
    const locale = req.query.uselang || req.query.useLang;
    if (locale && languages.isValid(locale) && locale !== req.locale) {
      req.localeChange = { old: req.locale, new: locale };
      i18n.setLocale(req, locale);
    }
    return next();
  });

  app.use('/api', api);

  // Upload processing has to be done before CSRF middleware kicks in
  app.use('/', stage1Router);

  app.use(csrfSynchronisedProtection);
  app.use('/', pages);
  app.use('/', reviews);
  app.use('/', actions);
  app.use('/', teams);
  app.use('/', files);
  app.use('/', blogPosts);
  app.use('/', apitest);
  app.use('/', stage2Router);
  app.use('/user', users);

  // Goes last to avoid accidental overlap w/ reserved routes
  app.use('/', things);

  // Catches 404s and serves "not found" page
  app.use(errorProvider.notFound);

  // Catches bad JSON, explicit next(error) calls, and other unhandled errors
  app.use(errorProvider.generic);

  // Webhooks let us notify other applications and services (local or remote) when something happens.
  // See configuration for the webHooks block to adjust behaviour.
  app.locals.webHooks = new WebHookDispatcher(config.webHooks);

  await Promise.all(asyncJobs);
  const mode = app.get('env') === 'production' ? 'PRODUCTION' : 'DEVELOPMENT';
  debug.app(`App is up and running in ${mode} mode.`);
  initializedApp = app;
  return app;
}

/**
 * Create a directory if it does not exist
 *
 * @param {String} dir
 *  relative path name
 * @memberof App
 */
async function setupDirectory(dir) {
  const directory = path.join(__dirname, dir);
  try {
    await fs.promises.mkdir(directory);
    debug.app(`Directory '${directory}' did not exist yet, creating.`);
  } catch (error) {
    if (error.code !== 'EEXIST')
      throw error;
    // Ignore collision: parallel test workers may ensure the same path.
  }
}

/**
 * Reset the cached Express app instance so integration tests can bootstrap
 * a fresh copy without relying on module cache hacks.
 *
 * @returns {Promise<void>}
 */
export async function resetAppForTesting() {
  if (!initializedApp)
    return;

  const vite = initializedApp.locals?.vite;
  if (vite && typeof vite.close === 'function') {
    try {
      await vite.close();
    } catch (error) {
      debug.app('Failed to close Vite dev server during test reset:', error);
    }
  }

  initializedApp = undefined;
}

export default getApp;
