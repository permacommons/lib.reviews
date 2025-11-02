import test from 'ava';
import http from 'http';
import WebHookDispatcher from '../util/webhooks.ts';

function createServer(handler) {
  const server = http.createServer(handler);
  return {
    server,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          if (address && typeof address === 'object' && 'port' in address) {
            resolve(address.port);
            return;
          }
          reject(new Error('Server did not expose an address with a port.'));
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(resolve));
    }
  };
}

test('dispatch posts payload to configured endpoints', async t => {
  const requests = [];
  const { server, listen, close } = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      });
      res.statusCode = 204;
      res.end();
    });
  });

  const port = await listen();
  t.teardown(() => close());

  const dispatcher = new WebHookDispatcher({
    newReview: [`http://127.0.0.1:${port}/reviews`]
  });

  const payload = { event: 'new-review', data: { author: 'Tester' } };
  const result = await dispatcher.trigger('newReview', payload);

  t.is(result.event, 'newReview');
  t.is(result.deliveries.length, 1);
  t.true(result.deliveries[0].ok);
  t.is(result.deliveries[0].status, 204);
  t.is(requests.length, 1);
  t.is(requests[0].method, 'POST');
  t.is(requests[0].url, '/reviews');
  t.deepEqual(requests[0].body, payload);
  t.is(requests[0].headers['content-type'], 'application/json');
});

test('failed dispatch reports status code', async t => {
  const { server, listen, close } = createServer((req, res) => {
    res.statusCode = 500;
    res.end('nope');
  });

  const port = await listen();
  t.teardown(() => close());

  const dispatcher = new WebHookDispatcher({
    newReview: [`http://127.0.0.1:${port}/reviews`]
  });

  const result = await dispatcher.trigger('newReview', { foo: 'bar' });

  t.is(result.deliveries.length, 1);
  t.false(result.deliveries[0].ok);
  t.is(result.deliveries[0].status, 500);
});

test('network errors surface as delivery failures', async t => {
  const dispatcher = new WebHookDispatcher(
    { newReview: ['http://127.0.0.1:9/reviews'] },
    { timeoutMs: 50 }
  );

  const result = await dispatcher.trigger('newReview', { foo: 'bar' });

  t.is(result.deliveries.length, 1);
  t.false(result.deliveries[0].ok);
  t.truthy(result.deliveries[0].error);
});
