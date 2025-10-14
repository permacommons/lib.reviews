import test from 'ava';
import { JSDOM } from 'jsdom';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Autocomplete = require('../frontend/lib/ac.js');

test.beforeEach(t => {
  const dom = new JSDOM('<!doctype html><html><body><input type="text" id="search"></body></html>', {
    pretendToBeVisual: true
  });

  t.context.dom = dom;
  Object.defineProperty(global, 'window', { value: dom.window, configurable: true });
  Object.defineProperty(global, 'document', { value: dom.window.document, configurable: true });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(global, 'Node', { value: dom.window.Node, configurable: true });
  Object.defineProperty(global, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(global, 'Event', { value: dom.window.Event, configurable: true });
});

test.afterEach.always(t => {
  const dom = t.context.dom;
  if (dom) {
    dom.window.close();
  }

  delete global.window;
  delete global.document;
  delete global.navigator;
  delete global.Node;
  delete global.HTMLElement;
  delete global.Event;
});

test('render builds rows and updates aria attributes', t => {
  const input = document.getElementById('search');
  const ac = new Autocomplete(input);
  ac.delay = 0;
  ac.mount();

  ac.results = [
    { title: 'Alpha', subtitle: 'One' },
    { title: 'Beta' }
  ];
  ac.render();

  t.is(ac.rowWrapperEl.children.length, 2);
  t.is(ac.rows.length, 2);

  ac.setSelectedIndex(1);
  t.is(ac.inputEl.getAttribute('aria-activedescendant'), ac.rows[1].id);
  t.is(ac.rows[1].getAttribute('aria-selected'), 'true');

  ac.deactivate();
});

test('createMatchTextEls highlights query prefix', t => {
  const fragment = Autocomplete.createMatchTextEls('Ex', 'Example');
  const nodes = Array.from(fragment.childNodes);
  t.is(nodes.length, 2);
  t.is(nodes[0].nodeName, 'B');
  t.is(nodes[0].textContent, 'Ex');
  t.is(nodes[1].nodeName, 'SPAN');
  t.is(nodes[1].textContent, 'ample');
});

test('trigger invokes callback with selected result', t => {
  const input = document.getElementById('search');
  let triggered = null;
  const ac = new Autocomplete(input, null, null, null, null, row => {
    triggered = row;
  });
  ac.mount();

  const result = { title: 'Gamma', url: 'https://example.com' };
  ac.results = [result];
  ac.render();
  ac.setSelectedIndex(0);
  ac.trigger(new window.Event('click'));

  t.deepEqual(triggered, result);
  t.is(input.value, result.title);
  t.is(ac.isMounted, false);
  ac.deactivate();
});
