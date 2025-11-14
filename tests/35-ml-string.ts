import test from 'ava';

import { QueryError, ValidationError } from '../dal/lib/errors.ts';
import mlString from '../dal/lib/ml-string.ts';
import { mockSearch, unmockSearch } from './helpers/mock-search.ts';
import { setupPostgresTest } from './helpers/setup-postgres-test.ts';

const { dalFixture, bootstrapPromise } = setupPostgresTest(test, {
  schemaNamespace: 'ml_string_validation',
  cleanupTables: ['reviews', 'things', 'users', 'teams'],
});

let Thing: any, Review: any, Team: any;

test.before(async () => {
  await bootstrapPromise;

  mockSearch();

  const models = await dalFixture.initializeModels([
    { key: 'things', alias: 'Thing' },
    { key: 'reviews', alias: 'Review' },
    { key: 'teams', alias: 'Team' },
  ]);

  Thing = models.Thing;
  Review = models.Review;
  Team = models.Team;
});

test.after.always(unmockSearch);

test('mlString.getSchema rejects HTML by default (strict mode)', t => {
  const schema = mlString.getSchema();

  const error = t.throws(
    () => {
      schema.validate({ en: '<p>Hello</p>' }, 'ml');
    },
    { instanceOf: ValidationError }
  );

  t.regex(error?.message ?? '', /contains HTML tags/);
});

test('mlString.getSchema allows HTML when allowHTML is true', t => {
  const schema = mlString.getSchema({ allowHTML: true });

  t.notThrows(() => {
    schema.validate({ en: '<p>Hello</p>' }, 'ml');
  });
});

test('mlString.getSchema rejects HTML when allowHTML is false', t => {
  const schema = mlString.getSchema({ allowHTML: false });

  const error = t.throws(
    () => {
      schema.validate({ en: '<em>Not allowed</em>' }, 'ml');
    },
    { instanceOf: ValidationError }
  );

  t.regex(error?.message ?? '', /contains HTML tags/);
});

test('mlString plain text schema enforces plain text for arrays', t => {
  const schema = mlString.getSafeTextSchema({ array: true });

  t.notThrows(() => {
    schema.validate({ en: ['One', 'Two'] }, 'ml');
  });

  const error = t.throws(
    () => {
      schema.validate({ en: ['Okay', '<b>nope</b>'] }, 'ml');
    },
    { instanceOf: ValidationError }
  );

  t.regex(error?.message ?? '', /contains HTML tags/);
});

test('mlString HTML schema permits HTML content', t => {
  const schema = mlString.getHTMLSchema();

  t.notThrows(() => {
    schema.validate({ en: '<section><p>Allowed</p></section>' }, 'ml');
  });
});

test('mlString rich text schema validates text/html pairing', t => {
  const schema = mlString.getRichTextSchema();

  t.notThrows(() => {
    schema.validate({
      text: { en: 'Markdown source' },
      html: { en: '<p>Rendered HTML</p>' },
    });
  });

  const htmlError = t.throws(
    () => {
      schema.validate({
        text: { en: '<strong>bad</strong>' },
      });
    },
    { instanceOf: ValidationError }
  );
  t.regex(htmlError?.message ?? '', /contains HTML tags/);

  const extraKeyError = t.throws(
    () => {
      schema.validate({
        text: { en: 'Okay' },
        html: { en: '<p>Ok</p>' },
        preview: { en: 'Nope' },
      });
    },
    { instanceOf: ValidationError }
  );
  t.regex(extraKeyError?.message ?? '', /unsupported keys/);
});

// ============================================================================
// INTEGRATION TESTS - Model validation
// ============================================================================

test.serial('Integration: Review model rejects HTML in title field', async t => {
  const { actor: author } = await dalFixture.createTestUser('Review Author XSS Test');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator XSS Test');

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = ['https://example.com/xss-test'];
  thingRev.label = { en: 'XSS Test Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const review = await Review.createFirstRevision(author, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: '<script>alert("xss")</script>Malicious Title' };
  review.text = { en: 'Plain text content' };
  review.html = { en: '<p>Rendered content</p>' };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = author.id;
  review.originalLanguage = 'en';

  const error = await t.throwsAsync(async () => await review.save(), {
    instanceOf: QueryError,
  });

  t.regex(error?.message ?? '', /contains HTML tags/);
  t.true(error?.originalError instanceof ValidationError);
});

test.serial('Integration: Review model accepts HTML in html field', async t => {
  const { actor: author } = await dalFixture.createTestUser('Review Author Valid HTML');
  const { actor: thingCreator } = await dalFixture.createTestUser('Thing Creator Valid HTML');

  const thingRev = await Thing.createFirstRevision(thingCreator, { tags: ['create'] });
  thingRev.urls = ['https://example.com/valid-html'];
  thingRev.label = { en: 'Valid HTML Thing' };
  thingRev.createdOn = new Date();
  thingRev.createdBy = thingCreator.id;
  const thing = await thingRev.save();

  const review = await Review.createFirstRevision(author, { tags: ['create'] });
  review.thingID = thing.id;
  review.title = { en: 'Valid Title' };
  review.text = { en: 'Plain markdown source' };
  review.html = { en: '<p>This <strong>HTML</strong> is allowed</p>' };
  review.starRating = 5;
  review.createdOn = new Date();
  review.createdBy = author.id;
  review.originalLanguage = 'en';

  const saved = await review.save();
  t.truthy(saved.id);
  t.is(saved.html?.en, '<p>This <strong>HTML</strong> is allowed</p>');
});

test.serial('Integration: Team model rejects HTML in name field', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Team Creator XSS');

  const team = await Team.createFirstRevision(creator, { tags: ['create'] });
  team.name = { en: '<img src=x onerror=alert(1)>Evil Team' };
  team.createdOn = new Date();
  team.createdBy = creator.id;

  const error = await t.throwsAsync(async () => await team.save(), {
    instanceOf: QueryError,
  });

  t.regex(error?.message ?? '', /contains HTML tags/);
  t.true(error?.originalError instanceof ValidationError);
});

test.serial('Integration: Team model accepts HTML in description.html', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Team Creator Valid');

  const team = await Team.createFirstRevision(creator, { tags: ['create'] });
  team.name = { en: 'Valid Team Name' };
  team.description = {
    text: { en: 'Plain text description' },
    html: { en: '<p>Rich <strong>HTML</strong> description</p>' },
  };
  team.createdOn = new Date();
  team.createdBy = creator.id;

  const saved = await team.save();
  t.truthy(saved.id);
  t.is(saved.description?.html?.en, '<p>Rich <strong>HTML</strong> description</p>');
});

test.serial('Integration: Thing model rejects HTML in label field', async t => {
  const { actor: creator } = await dalFixture.createTestUser('Thing Creator XSS');

  const thing = await Thing.createFirstRevision(creator, { tags: ['create'] });
  thing.urls = ['https://example.com/xss-thing'];
  thing.label = { en: '<b>Bold</b> Thing Label' };
  thing.createdOn = new Date();
  thing.createdBy = creator.id;

  const error = await t.throwsAsync(async () => await thing.save(), {
    instanceOf: QueryError,
  });

  t.regex(error?.message ?? '', /contains HTML tags/);
  t.true(error?.originalError instanceof ValidationError);
});
