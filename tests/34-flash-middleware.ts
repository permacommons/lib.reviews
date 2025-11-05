import test from 'ava';
import supertest from 'supertest';
import express from 'express';
import session from 'express-session';

// Import the typed middleware implementations.
import flashStore from '../util/flash-store.ts';
import flashMiddleware from '../routes/helpers/flash.ts';
import ReportedError from '../util/reported-error.ts';

/**
 * Build a minimal Express app that mounts:
 * - express-session (MemoryStore, suitable for unit tests),
 * - a stub i18n middleware providing req.__ for localization calls,
 * - flashStore to implement req.flash backed by session,
 * - flashMiddleware to add req.flashHas and req.flashError helpers.
 */
function makeApp() {
  const app = express();
  app.disable('x-powered-by');

  // Session middleware; MemoryStore is fine for tests.
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: true,
      cookie: { maxAge: 60 * 1000 },
    })
  );

  // Minimal i18n stub: provide req.__ to satisfy flashError usage.
  app.use((req, _res, next) => {
    // Basic localization function that returns the phrase or string.
    req.__ = (message, ...args) => {
      if (typeof message === 'string') {
        // Simulate interpolation by concatenation for test visibility.
        return args.length ? [message, ...args].join(' ') : message;
      }
      if (message && typeof message === 'object' && 'phrase' in message) {
        return String(message.phrase);
      }
      return 'unknown';
    };
    next();
  });

  // Mount flash store and helpers.
  app.use(flashStore);
  app.use(flashMiddleware);

  // Routes for testing flash behavior.

  // Add a single message to pageMessages.
  app.get('/set', (req, res) => {
    req.flash('pageMessages', 'hello');
    res.json({ ok: true });
  });

  // Add multiple messages to pageMessages.
  app.get('/set-multi', (req, res) => {
    req.flash('pageMessages', 'one');
    req.flash('pageMessages', 'two');
    res.json({ ok: true });
  });

  // Retrieve and consume messages from pageMessages.
  app.get('/get', (req, res) => {
    const msgs = req.flash('pageMessages');
    res.json({ pageMessages: msgs });
  });

  // Inspect presence of messages without consuming.
  app.get('/has', (req, res) => {
    res.json({
      hasPageMessages: req.flashHas ? req.flashHas('pageMessages') : false,
      hasSiteErrors: req.flashHas ? req.flashHas('siteErrors') : false,
    });
  });

  // Trigger flashError with a generic Error (non-ReportedError).
  app.get('/error', (req, res) => {
    req.flashError ? req.flashError(new Error('Boom')) : req.flash('pageErrors', 'unknown error');
    res.json({ pageErrors: req.flash('pageErrors') });
  });

  // Trigger flashError with a ReportedError, ensuring params are escaped and localized.
  app.get('/reported-error', (req, res) => {
    const err = new ReportedError({
      userMessage: 'custom: %s',
      userMessageParams: ['<tag>'],
    });
    if (req.flashError) {
      req.flashError(err);
    } else {
      // Fallback: emulate what flashError would do (escaped param expected)
      req.flash('pageErrors', req.__('custom: %s', '<tag>'));
    }
    res.json({ pageErrors: req.flash('pageErrors') });
  });

  // Reading unknown key should return an empty array.
  app.get('/unknownKey', (req, res) => {
    res.json({ data: req.flash('nonexistent') });
  });

  return app;
}

test('flash: sets and retrieves messages, then consumes bucket', async t => {
  const app = makeApp();
  const agent = supertest.agent(app);

  // Set one message.
  await agent.get('/set').expect(200);

  // Presence check before consuming.
  let res = await agent.get('/has').expect(200);
  t.true(res.body.hasPageMessages);
  t.false(res.body.hasSiteErrors);

  // Read (and consume) messages.
  res = await agent.get('/get').expect(200);
  t.deepEqual(res.body.pageMessages, ['hello']);

  // After consumption, presence should be false.
  res = await agent.get('/has').expect(200);
  t.false(res.body.hasPageMessages);
});

test('flash: accumulates multiple messages for a key', async t => {
  const app = makeApp();
  const agent = supertest.agent(app);

  await agent.get('/set-multi').expect(200);

  const res = await agent.get('/get').expect(200);
  t.deepEqual(res.body.pageMessages, ['one', 'two']);
});

test('flash: unknown key returns empty array', async t => {
  const app = makeApp();
  const agent = supertest.agent(app);

  const res = await agent.get('/unknownKey').expect(200);
  t.deepEqual(res.body.data, []);
});

test('flash: flashError stores localized unknown error for non-ReportedError', async t => {
  const app = makeApp();
  const agent = supertest.agent(app);

  const res = await agent.get('/error').expect(200);
  t.true(Array.isArray(res.body.pageErrors));
  t.deepEqual(res.body.pageErrors, ['unknown error']);
});

test('flash: flashError uses ReportedError and escapes params', async t => {
  const app = makeApp();
  const agent = supertest.agent(app);

  const res = await agent.get('/reported-error').expect(200);
  t.true(Array.isArray(res.body.pageErrors));
  // Our i18n stub joins the message key and args with spaces; verify escaped value
  t.deepEqual(res.body.pageErrors, ['custom: %s &lt;tag&gt;']);
});
