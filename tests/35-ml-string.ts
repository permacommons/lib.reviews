import test from 'ava';

import { ValidationError } from '../dal/lib/errors.ts';
import mlString from '../dal/lib/ml-string.ts';

test('mlString.getSchema allows HTML content by default', t => {
  const schema = mlString.getSchema();

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
  const schema = mlString.getPlainTextSchema({ array: true });

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
