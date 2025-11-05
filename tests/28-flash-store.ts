import test from 'ava';
import flashStore from '../util/flash-store.ts';

type FlashRequest = Parameters<typeof flashStore>[0];
type FlashResponse = Parameters<typeof flashStore>[1];
type FlashNext = Parameters<typeof flashStore>[2];

const createFlashRequest = (): FlashRequest =>
  ({
    session: {} as NonNullable<FlashRequest['session']>,
  }) as FlashRequest;

const createResponse = (): FlashResponse => ({}) as FlashResponse;

test('stores and retrieves flash messages on the session', t => {
  const req = createFlashRequest();
  const res = createResponse();
  let nextCalled = false;

  flashStore(req, res, (() => {
    nextCalled = true;
  }) as FlashNext);

  t.true(nextCalled, 'middleware calls next once registered');
  t.is(typeof req.flash, 'function', 'flash helper is attached to the request');

  req.flash('pageErrors', 'first issue');
  req.flash('pageErrors', 'second issue');

  t.deepEqual(
    req.session.flash.pageErrors,
    ['first issue', 'second issue'],
    'messages stored on the session'
  );

  const messages = req.flash('pageErrors');
  t.deepEqual(messages, ['first issue', 'second issue'], 'messages returned when read');
  t.falsy(
    req.session.flash && Object.hasOwn(req.session.flash, 'pageErrors'),
    'flash bucket is cleared after read'
  );
  t.false(Object.hasOwn(req.session, 'flash'), 'flash store is removed when empty');
  t.deepEqual(req.flash('pageErrors'), [], 'subsequent reads yield an empty array');
});

test('reading a missing flash bucket returns an empty array', t => {
  const req = createFlashRequest();
  flashStore(req, createResponse(), (() => {}) as FlashNext);

  t.deepEqual(req.flash('non-existent'), []);
});

test('the middleware reports when session support is missing', t => {
  let reportedError;
  flashStore({} as FlashRequest, createResponse(), (error => {
    reportedError = error;
  }) as FlashNext);

  t.truthy(reportedError);
  t.is(
    reportedError.message,
    'Flash storage requires session middleware to be registered before it.'
  );
});
