'use strict';

/**
 * The main logic for initializing an instance of the lib.reviews Express web
 * application.
 *
 * @namespace App
 */

// External dependencies
const express = require('express');
const path = require('path');
const fs = require('fs');
const util = require('util');
const favicon = require('serve-favicon');
const serveIndex = require('serve-index');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const i18n = require('i18n');
const hbs = require('hbs'); // handlebars templating
const hbsutils = require('hbs-utils')(hbs);
const lessMiddleware = require('less-middleware');
const session = require('express-session');
const RDBStore = require('session-rethinkdb')(session);
const flash = require('express-flash');
const useragent = require('express-useragent');
const passport = require('passport');
const csrf = require('csurf'); // protect against request forgery using tokens
const config = require('config');
const compression = require('compression');
const WebHooks = require('node-webhooks');
const csp = require('helmet-csp'); // Content security policy

// Internal dependencies
const languages = require('./locales/languages');
const reviews = require('./routes/reviews');
const actions = require('./routes/actions');
const users = require('./routes/users');
const teams = require('./routes/teams');
const pages = require('./routes/pages');
const files = require('./routes/files');
const uploads = require('./routes/uploads');
const blogPosts = require('./routes/blog-posts');
const api = require('./routes/api');
const apiHelper = require('./routes/helpers/api');
const flashHelper = require('./routes/helpers/flash');
const things = require('./routes/things');
const ErrorProvider = require('./routes/errors');
const debug = require('./util/debug');
const apitest = require('./routes/apitest');

// Initialize custom HBS helpers
require('./util/handlebars-helpers.js');

let initializedApp;

/**
 * Initialize an instance of the app and provide it when it is ready for use.
 * @param {Thinky} [db=default database instance]
 *  a reference to an ODM instance with an active connection pool. If not
 *  provided, we will attempt to acquire the configured instance.
 * @returns {Function}
 *  an Express app
 * @memberof App
 */
async function getApp(db = require('./db')) {
  if (initializedApp)
    return initializedApp;

  // Push promises into this array that need to resolve before the app itself
  // is ready for use
  let asyncJobs = [];

  // Create directories for uploads and deleted files if needed
  asyncJobs.push(...['deleted', 'static/uploads', 'static/downloads'].map(setupDirectory));

  // Auth setup
  require('./auth');

  // i18n setup
  i18n.configure({
    locales: languages.getValidLanguages(),
    cookie: 'locale',
    // Tests set NODE_CONFIG_DISABLE_WATCH to keep the config module from
    // registering filesystem watchers that would keep AVA workers alive.
    autoReload: process.env.NODE_CONFIG_DISABLE_WATCH !== 'Y',
    updateFiles: false,
    retryInDefaultLocale: true,
    directory: __dirname + '/locales'
  });


  // express setup
  const app = express();

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));

  asyncJobs.push(new Promise(resolveJob =>
    hbsutils.registerPartials(__dirname + '/views/partials', undefined, () => resolveJob())
  ));

  app.set('view engine', 'hbs');

  // Prevent unsafe embeds on HTTPS
  if (config.forceHTTPS)
    app.use(csp({
      directives: { upgradeInsecureRequests: true }
    }));

  app.use(cookieParser());
  app.use(i18n.init); // Requires cookie parser!
  app.use(useragent.express()); // expose UA object to req.useragent

  const store = new RDBStore(db.r, {
    table: 'sessions'
  });

  // We do not get an error event from this module, so this is a potential
  // cause of hangs during the initialization. Set DEBUG=session to debug.
  asyncJobs.push(new Promise((resolve, reject) => {
    debug.app('Awaiting session store initialization.');
    store.on('connect', function() {
      debug.app('Session store initialized.');
      db.r
        .table('sessions')
        .wait({ timeout: 5 })
        .then(resolve)
        .catch(reject);
    });
  }));

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

  app.use(flash());
  app.use(flashHelper);

  app.use(compression());

  app.use(favicon(path.join(__dirname, 'static/img/favicon.ico'))); // not logged

  if (config.get('logger'))
    app.use(logger(config.get('logger')));

  app.use('/static/downloads', serveIndex(path.join(__dirname, 'static/downloads'), {
    'icons': true,
    template: path.join(__dirname, 'views/downloads.html')
  }));

  let cssPath = path.join(__dirname, 'static', 'css');
  app.use('/static/css', lessMiddleware(cssPath));

  // Cache immutable assets for one year
  app.use('/static', function(req, res, next) {
    if (/.*\.(svg|jpg|webm|gif|png|ogg|tgz|zip|woff2)$/.test(req.path))
      res.set('Cache-Control', 'public, max-age=31536000');
    return next();
  });

  app.use('/static', express.static(path.join(__dirname, 'static')));

  app.use('/robots.txt', (req, res) => {
    res.type('text');
    res.send('User-agent: *\nDisallow: /api/\n');
  });

  // Initialize Passport and restore authentication state, if any, from the
  // session.
  app.use(passport.initialize());
  app.use(passport.session());

  // API requests do not require CSRF tokens (hence declared before CSRF
  // middleware), but session-authenticated POST requests do require the
  // X-Requested-With header to be set, which ensures they're subject to CORS
  // rules. This middleware also sets req.isAPI to true for API requests.
  app.use('/api', apiHelper.prepareRequest);

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({
    extended: false
  }));

  let errorProvider = new ErrorProvider(app);

  if (config.maintenanceMode) {
    // Will not pass along control to any future routes but just render
    // generic maintenance mode message instead
    app.use('/', errorProvider.maintenanceMode);
  }

  // ?uselang=xx changes language temporarily if xx is a valid, different code
  app.use('/', function(req, res, next) {
    let locale = req.query.uselang || req.query.useLang;
    if (locale && languages.isValid(locale) && locale !== req.locale) {
      req.localeChange = { old: req.locale, new: locale };
      i18n.setLocale(req, locale);
    }
    return next();
  });

  app.use('/api', api);

  // Upload processing has to be done before CSRF middleware kicks in
  app.use('/', uploads.stage1Router);

  app.use(csrf());
  app.use('/', pages);
  app.use('/', reviews);
  app.use('/', actions);
  app.use('/', teams);
  app.use('/', files);
  app.use('/', blogPosts);
  app.use('/', apitest);
  app.use('/', uploads.stage2Router);
  app.use('/user', users);

  // Goes last to avoid accidental overlap w/ reserved routes
  app.use('/', things);

  // Catches 404s and serves "not found" page
  app.use(errorProvider.notFound);

  // Catches the following:
  // - bad JSON data in POST bodies
  // - errors explicitly passed along with next(error)
  // - other unhandled errors
  app.use(errorProvider.generic);

  // Webhooks let us notify other applications and services (running on the
  // same server or elsewhere) when something happens. See the configuration
  // file for details.
  app.locals.webHooks = new WebHooks({ db: config.webHooks });

  await Promise.all(asyncJobs);
  const mode = app.get('env') == 'production' ? 'PRODUCTION' : 'DEVELOPMENT';
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
  dir = path.join(__dirname, dir);
  let exists = util.promisify(fs.exists),
    mkdir = util.promisify(fs.mkdir);

  if (!await exists(dir)) {
    debug.app(`Directory '${dir}' does not exist yet, creating.`);
    await mkdir(dir);
  }
}

module.exports = getApp;
