/**
 * The main logic for initializing an instance of the lib.reviews Express web
 * application.
 *
 * @namespace App
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bodyParser from 'body-parser';
import compression from 'compression';
import config from 'config';
import connectPgSimple from 'connect-pg-simple';
import cookieParser from 'cookie-parser';
// External dependencies
import type { Request, Response } from 'express';
import express from 'express';
import session from 'express-session';
import expressUserAgent from 'express-useragent';
import hbs from 'hbs'; // handlebars templating
import hbsUtilsFactory from 'hbs-utils';
import csp from 'helmet-csp'; // Content security policy
import i18n from 'i18n';
import logger from 'morgan';
import passport from 'passport';
import favicon from 'serve-favicon';
import serveIndex from 'serve-index';
import { initializeDAL } from './bootstrap/dal.ts';
import ErrorProvider from './routes/errors.ts';
import apiHelper from './routes/helpers/api.ts';
import flashHelper from './routes/helpers/flash.ts';
import clientAssets from './util/client-assets.ts';
import { csrfSynchronisedProtection } from './util/csrf.ts';
import debug from './util/debug.ts';
import flashStore from './util/flash-store.ts';
import WebHookDispatcher from './util/webhooks.ts';
import './util/handlebars-helpers.ts';
import languages from './locales/languages.ts';

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
  if (initializedApp) return initializedApp;

  // Push promises into this array that need to resolve before the app itself
  // is ready for use
  const asyncJobs: Array<Promise<unknown>> = [];

  // Resolve runtime paths for static assets and deleted files (environment-agnostic).
  // Final architecture: serve static/ and deleted/ from the repository root in both
  // development and production to avoid copying/wiping immutable assets.
  const repoRoot = process.cwd();
  const resolvedStaticDir = path.join(repoRoot, 'static');
  const resolvedUploadsDir = path.join(resolvedStaticDir, 'uploads');
  const resolvedDownloadsDir = path.join(resolvedStaticDir, 'downloads');
  const resolvedDeletedDir = path.join(repoRoot, 'deleted');

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
    directory: path.join(__dirname, 'locales'),
  });

  const app = express();

  // Centralize absolute runtime paths for routes/middlewares to consume
  app.locals.paths = {
    runtimeRoot: __dirname,
    staticDir: resolvedStaticDir,
    uploadsDir: resolvedUploadsDir,
    downloadsDir: resolvedDownloadsDir,
    deletedDir: resolvedDeletedDir,
  } as {
    runtimeRoot: string;
    staticDir: string;
    uploadsDir: string;
    downloadsDir: string;
    deletedDir: string;
  };

  // Ensure required directories exist at startup
  asyncJobs.push(
    ...[
      app.locals.paths.deletedDir,
      app.locals.paths.uploadsDir,
      app.locals.paths.downloadsDir,
    ].map(setupDirectory)
  );

  // Pin the Vite manifest directory for production builds to avoid guessing
  clientAssets.setManifestDir(path.join(process.cwd(), 'build', 'frontend', '.vite'));

  app.set('views', path.join(__dirname, 'views'));

  asyncJobs.push(
    new Promise<void>(resolveJob => {
      hbsutils.registerPartials(path.join(__dirname, 'views/partials'), undefined, () =>
        resolveJob()
      );
    })
  );

  app.set('view engine', 'hbs');

  if (config.forceHTTPS)
    app.use(
      csp({
        directives: { upgradeInsecureRequests: true },
      })
    );

  app.use(cookieParser());
  app.use(i18n.init); // requires cookie parser above
  app.use(expressUserAgentMiddleware()); // expose UA object to req.useragent

  const dal = await dalPromise;
  app.locals.dal = dal;

  const { default: reviews } = await import('./routes/reviews.ts');
  const { default: actions } = await import('./routes/actions.ts');
  const { default: users } = await import('./routes/users.ts');
  const { default: teams } = await import('./routes/teams.ts');
  const { default: things } = await import('./routes/things.ts');
  const { default: files } = await import('./routes/files.ts');
  const { default: api } = await import('./routes/api.ts');
  const { default: pages } = await import('./routes/pages.ts');
  const { default: blogPosts } = await import('./routes/blog-posts.ts');
  const { stage1Router, stage2Router } = await import('./routes/uploads.ts');

  // Ensure DAL pool is initialized and typed for connect-pg-simple
  const pool = dal.pool;
  if (!pool) throw new Error('DAL pool not initialized');
  const store = new PgSessionStore({
    pool,
    tableName: 'session',
  });

  app.use(
    session({
      name: 'libreviews_session',
      resave: true,
      saveUninitialized: true,
      secret: config.get('sessionSecret'),
      cookie: {
        maxAge: config.get('sessionCookieDuration') * 1000 * 60,
      },
      store,
    })
  );

  app.use(flashStore);
  app.use(flashHelper);

  app.use(compression());

  app.use(favicon(path.join(app.locals.paths.staticDir, 'img', 'favicon.ico')));

  const loggerConfigValue = config.get('logger');
  if (typeof loggerConfigValue === 'string' && loggerConfigValue !== '')
    app.use(logger(loggerConfigValue));

  app.use(
    '/static/downloads',
    serveIndex(app.locals.paths.downloadsDir, {
      icons: true,
      template: path.join(__dirname, 'views/downloads.html'),
    })
  );

  app.use('/static', (req: Request, res: Response, next) => {
    if (/.*\.(svg|jpg|webm|gif|png|ogg|tgz|zip|woff2|jpeg)$/i.test(req.path))
      res.set('Cache-Control', 'public, max-age=31536000');
    return next();
  });

  app.use('/static', express.static(app.locals.paths.staticDir));

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

  app.use(
    '/assets',
    express.static(path.join(process.cwd(), 'build', 'frontend'), {
      fallthrough: true,
      maxAge: '1y',
    })
  );

  if (process.env.NODE_ENV !== 'production' && process.env.LIBREVIEWS_VITE_DEV_SERVER !== 'off') {
    const viteConfigPath = path.join(__dirname, 'vite.config.ts');
    const createViteServer = async () => {
      const { createServer } = await import('vite');
      return createServer({
        configFile: viteConfigPath,
        server: {
          middlewareMode: true,
          watch: {
            usePolling: process.env.VITE_USE_POLLING === '1',
          },
        },
        appType: 'custom',
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

  // Initialize Passport and restore authentication state, if any, from the session.
  app.use(passport.initialize());
  app.use(passport.session());

  // API requests do not require CSRF tokens (hence declared before CSRF middleware),
  // but session-authenticated POST requests do require the X-Requested-With header to be set,
  // which ensures they're subject to CORS rules. This middleware also sets req.isAPI to true.
  app.use('/api', apiHelper.prepareRequest);

  app.use(bodyParser.json());
  app.use(
    bodyParser.urlencoded({
      extended: true, // Enable qs parsing for bracket notation (field[key][subkey])
    })
  );

  const errorProvider = new ErrorProvider(app);

  if (config.maintenanceMode) app.use('/', errorProvider.maintenanceMode);

  // ?uselang=xx changes language temporarily if xx is a valid, different code
  app.use('/', (req, _res, next) => {
    const rawLocale = req.query.uselang ?? req.query.useLang;
    const localeCandidate = Array.isArray(rawLocale) ? rawLocale[0] : rawLocale;
    if (
      typeof localeCandidate === 'string' &&
      languages.isValid(localeCandidate) &&
      localeCandidate !== req.locale
    ) {
      const newLocale = localeCandidate as LibReviews.LocaleCode;
      const oldLocale: LibReviews.LocaleCodeWithUndetermined =
        typeof req.locale === 'string' && languages.isValid(req.locale)
          ? (req.locale as LibReviews.LocaleCode)
          : 'und';
      req.localeChange = { old: oldLocale, new: newLocale };
      i18n.setLocale(req, newLocale);
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
 * @param dir
 *  relative path name
 * @memberof App
 */
async function setupDirectory(dir: string): Promise<void> {
  const directory = path.isAbsolute(dir) ? dir : path.join(__dirname, dir);
  try {
    await fs.promises.mkdir(directory);
    debug.app(`Directory '${directory}' did not exist yet, creating.`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Reset the cached Express app instance so integration tests can bootstrap
 * a fresh copy without relying on module cache hacks.
 */
export async function resetAppForTesting(): Promise<void> {
  if (!initializedApp) return;

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
