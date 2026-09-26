import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'ava';
import jQueryFactory from 'jquery';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const sisyphusSource = readFileSync(require.resolve('sisyphus.js/sisyphus.js'), 'utf8');

// Mirrors the autosave-relevant parts of views/review-form.hbs
const reviewFormHTML = (revID: string, title = '') => `<!doctype html><html><body>
<form id="review-form" name="review-form" method="post">
  <input type="hidden" value="csrf-token" name="_csrf" id="review-token" data-ignore-autosave>
  <input type="hidden" value="${revID}" name="rev-id" id="review-rev-id">
  <input id="review-title" name="review-title" type="text" value="${title}">
  <input id="review-language" name="review-language" type="hidden" data-ignore-autosave value="en">
</form>
</body></html>`;

type Sisyphus = { saveAllData(): void };

// Load the form with jQuery and Sisyphus configured as in frontend/review.ts
const loadReviewForm = (html: string, storage?: Storage) => {
  const dom = new JSDOM(html, { url: 'https://lib.reviews.test/new/review' });
  if (storage) {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) as string;
      dom.window.localStorage.setItem(key, storage.getItem(key) as string);
    }
  }
  const $ = (jQueryFactory as unknown as (window: Window) => JQueryStatic)(
    dom.window as unknown as Window
  );
  new Function('window', 'document', 'jQuery', 'localStorage', 'location', sisyphusSource)(
    dom.window,
    dom.window.document,
    $,
    dom.window.localStorage,
    dom.window.location
  );
  const sisyphus = (
    $('#review-form') as unknown as { sisyphus(options: object): Sisyphus }
  ).sisyphus({
    excludeFields: $('[data-ignore-autosave]'),
  });
  return { dom, $, sisyphus };
};

test('a restored review draft carries the revision ID it was written against', t => {
  const draftRevID = '7f8a2c4e-0c1b-4d8e-9a3f-2b6c1d0e5f41';
  const newerRevID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  const draftPage = loadReviewForm(reviewFormHTML(draftRevID, 'Draft title'));
  draftPage.sisyphus.saveAllData();
  const storage = draftPage.dom.window.localStorage;

  const storedValues = Array.from({ length: storage.length }, (_, i) =>
    storage.getItem(storage.key(i) as string)
  );
  t.true(storedValues.includes(draftRevID), 'revision ID is stored with the draft');
  t.false(storedValues.includes('csrf-token'), 'fields marked data-ignore-autosave are not stored');

  // A fresh form, loaded after someone else saved a newer revision
  const restoredPage = loadReviewForm(reviewFormHTML(newerRevID), storage);
  t.is(restoredPage.$('#review-title').val(), 'Draft title');
  t.is(restoredPage.$('#review-rev-id').val(), draftRevID);

  draftPage.dom.window.close();
  restoredPage.dom.window.close();
});
