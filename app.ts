/**
 * The main logic for initializing an instance of the lib.reviews Express web
 * application.
 *
 * @namespace App
 */

// External dependencies
import type { Request, Response } from 'express';
import bodyParser from 'body-parser';
import compression from 'compression';
import config from 'config';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import favicon from 'serve-favicon';
import fs from 'node:fs';
import hbs from 'hbs'; // handlebars templating
import hbsUtilsFactory from 'hbs-utils';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18n from 'i18n';
import logger from 'morgan';
import passport from 'passport';
import serveIndex from 'serve-index';
import csp from 'helmet-csp'; // Content security policy
import expressUserAgent from 'express-useragent';

import { csrfSynchronisedProtection } from './util/csrf.ts';
import { initializeDAL } from './bootstrap/dal.ts';
import ErrorProvider from './routes/errors.ts';
import apiHelper from './routes/helpers/api.ts';
import flashHelper from './routes/helpers/flash.ts';
import clientAssets from './util/client-assets.ts';
import debug from './util/debug.ts';
import flashStore from './util/flash-store.ts';
import WebHookDispatcher from './util/webhooks.ts';
import './util/handlebars-helpers.ts';
import languages from './locales/languages.js';

// Internal dependencies

const hbsutils = hbsUtilsFactory(hbs);
const PgSessionStore = connectPgSimple(session);
const expressUserAgentMiddleware = expressUserAgent.express;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let initializedApp: express.Express | undefined;

/**
 * Initialize an instance of the app and provide it when it is ready for use.
 * @returns an Express app
 */
async function getApp(): Promise<express.Express> {
  if (initializedApp)
    return initializedApp;

  const asyncJobs: Array<Promise<unknown>> = [];

  asyncJobs.push(...['deleted', 'static/uploads', 'static/downloads'].map(setupDirectory));

  const dalPromise = initializeDAL();
  asyncJobs.push(dalPromise);

  await import('./auth.ts');

  i18n.configure({
    locales: languages.getValidLanguages(),
    cookie: 'locale',
    defaultLocale: 'en',
    autoReload: process.env.NODE_CONFIG_DISABLE_WATCH !== 'Y',
    updateFiles: false,
    retryInDefaultLocale: true,
    directory: path.join(__dirname, 'locales')
  });

  const app = express();

  app.set('views', path.join(__dirname, 'views'));

  asyncJobs.push(new Promise<void>(resolveJob => {
    hbsutils.registerPartials(path.join(__dirname, 'views/partials'), undefined, () => resolveJob());
  }));

  app.set('view engine', 'hbs');

  if (config.forceHTTPS)
    app.use(csp({
      directives: { upgradeInsecureRequests: true }
    }));

  app.use(cookieParser());
  app.use(i18n.init);
  app.use(expressUserAgentMiddleware());

  const dal = await dalPromise;
  app.locals.dal = dal;

  const { default: reviews } = await import('./routes/reviews.js');
  const { default: actions } = await import('./routes/actions.js');
  const { default: users } = await import('./routes/users.js');
  const { default: teams } = await import('./routes/teams.js');
  const { default: things } = await import('./routes/things.js');
  const { default: files } = await import('./routes/files.js');
  const { default: api } = await import('./routes/api.js');
  const { default: pages } = await import('./routes/pages.js');
  const { default: blogPosts } = await import('./routes/blog-posts.js');
  const { stage1Router, stage2Router } = await import('./routes/uploads.js');

  const store = new PgSessionStore({
    pool: dal.pool,
    tableName: 'session'
  });

  app.use(session({
    name: 'libreviews_session',
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

  app.use(favicon(path.join(__dirname, 'static/img/favicon.ico')));

  if (config.get('logger'))
    app.use(logger(config.get('logger')));

  app.use('/static/downloads', serveIndex(path.join(__dirname, 'static/downloads'), {
    icons: true,
    template: path.join(__dirname, 'views/downloads.html')
  }));

  app.use('/static', (req: Request, res: Response, next) => {
    if (/.*\.(svg|jpg|webm|gif|png|ogg|tgz|zip|woff2)$/.test(req.path))
      res.set('Cache-Control', 'public, max-age=31536000');
    return next();
  });

  app.use('/static', express.static(path.join(__dirname, 'static')));

  if (process.env.NODE_ENV !== 'production') {
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
    const viteConfigPath = path.join(__dirname, 'vite.config.ts');
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

  app.use('/robots.txt', (_req, res) => {
    res.type('text');
    res.send('User-agent: *\nDisallow: /api/\n');
  });

  app.use(passport.initialize());
  app.use(passport.session());

  app.use('/api', apiHelper.prepareRequest);

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({
    extended: false
  }));

  const errorProvider = new ErrorProvider(app);

  if (config.maintenanceMode)
    app.use('/', errorProvider.maintenanceMode);

  app.use('/', (req, _res, next) => {
    const rawLocale = req.query.uselang ?? req.query.useLang;
    const locale = Array.isArray(rawLocale) ? rawLocale[0] : rawLocale;
    if (locale && languages.isValid(locale) && locale !== req.locale) {
      const newLocale = locale as LibReviews.LocaleCode;
      req.localeChange = { old: req.locale ?? 'und', new: newLocale };
      i18n.setLocale(req, newLocale);
    }
    return next();
  });

  app.use('/api', api);
  app.use('/', stage1Router);
  app.use(csrfSynchronisedProtection);
  app.use('/', pages);
  app.use('/', reviews);
  app.use('/', actions);
  app.use('/', teams);
  app.use('/', files);
  app.use('/', blogPosts);
  app.use('/', stage2Router);
  app.use('/user', users);
  app.use('/', things);

  app.use(errorProvider.notFound);
  app.use(errorProvider.generic);

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
 * @param dir
 *  relative path name
 * @memberof App
 */
async function setupDirectory(dir: string): Promise<void> {
  const directory = path.join(__dirname, dir);
  try {
    await fs.promises.mkdir(directory);
    debug.app(`Directory '${directory}' did not exist yet, creating.`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST')
      throw err;
  }
}

/**
 * Reset the cached Express app instance so integration tests can bootstrap
 * a fresh copy without relying on module cache hacks.
 */
export async function resetAppForTesting(): Promise<void> {
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
