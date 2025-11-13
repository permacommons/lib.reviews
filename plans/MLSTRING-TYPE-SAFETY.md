# Multilingual String Type Safety Implementation Plan

**Status**: Implementation In Progress - Refinement Phase
**Created**: 2025-11-11
**Revised**: 2025-11-13
**Approach**: Runtime validation + HTML-safe text storage

## Executive Summary

This plan adds runtime validation to distinguish plain text multilingual strings from HTML content. Each phase can be committed independently while keeping all tests green.

**Key insight:** Text fields store "HTML-safe text" (entities escaped, tags stripped) at write time. Templates render this safely without additional escaping. This enables write-time validation while supporting multiple output contexts.

**Storage model:** Text is stored with HTML entities escaped (`My &amp; Co`, `&lt;b&gt;`). User-entered content preserves the literal text they type (including literal angle brackets). External data from adapters has HTML tags stripped before entity escaping. For HTML output, use as-is. For plain text contexts (emails, etc.), decode entities with `decodeHTML()`.

## Problem Statement

Currently all multilingual strings use the same validation (`mlString.getSchema()`), whether they contain:
- Plain text (labels, titles) - should be HTML-safe
- Markdown source (review.text) - should be HTML-safe
- Rendered HTML (review.html) - contains actual HTML tags

This creates:
1. **XSS risk**: Nothing prevents storing `<script>` in a plain text field
2. **Type ambiguity**: Developers must memorize which fields contain what
3. **Template confusion**: All fields use `{{{mlString}}}` (unescaped)
4. **Inconsistent escaping**: Some text is entity-escaped, some isn't (depends on source)

## Current Field Patterns

Based on comprehensive codebase analysis:

### Pattern A: HTML-Safe Text Fields
Strings with HTML entities escaped. User input preserves literal angle brackets as `&lt;&gt;`. Adapter input has unwanted HTML tags stripped first.

**Examples:** `review.title`, `team.name`, `team.motto`, `thing.label`

**Storage:**
- User types `My & "Cool" <Company>` → `{ en: "My &amp; &quot;Cool&quot; &lt;Company&gt;" }`
- Adapter returns `My <b>Label</b>` → strip tags → `{ en: "My Label" }`

### Pattern B: Rich Text Sibling Fields
Markdown source + cached rendered HTML as separate fields.

**Examples:** `review.text` + `review.html`, `blogPost.text` + `blogPost.html`

**Storage:**
```javascript
review.text = { en: "markdown" }      // Plain text
review.html = { en: "<p>HTML</p>" }   // Rendered HTML
```

### Pattern C: Rich Text Nested Fields
Markdown source + cached rendered HTML in one nested object.

**Examples:** `team.description`, `team.rules`, `userMeta.bio`

**Storage:**
```javascript
team.description = {
  text: { en: "markdown" },
  html: { en: "<p>HTML</p>" }
}
```

### Pattern D: Array Fields
Arrays of plain text multilingual strings.

**Examples:** `thing.aliases`, `thing.metadata.authors`

## Proposed Solution

### Three Schema Methods

```typescript
// Plain text - rejects HTML
mlString.getSafeTextSchema({ maxLength?: number, array?: boolean })

// HTML - allows HTML (use only for cached rendered markdown)
mlString.getHTMLSchema({ maxLength?: number })

// Rich text - validates { text: plain, html: html }
mlString.getRichTextSchema()
```

### Two Template Helpers

```handlebars
{{!-- Auto-escapes for safety --}}
{{mlSafeText review.title}}

{{!-- No escaping for pre-rendered HTML --}}
{{{mlHTML review.html}}}
```

### Runtime Validation

Uses `stripTags()` to detect HTML:

```typescript
if (!allowHTML) {
  const stripped = stripTags(langValue);
  if (stripped !== langValue) {
    throw new ValidationError(
      `Plain text field for language '${langKey}' contains HTML tags`
    );
  }
}
```

## Migration Phases

Each phase can be committed independently with all tests passing.

---

### Phase 1: Core Implementation (Permissive Mode)

**Goal**: Add new APIs without changing behavior.

**Changes:**
1. Add `allowHTML` option to `getSchema()` (default: `true` for compatibility)
2. Add `getSafeTextSchema()`, `getHTMLSchema()`, `getRichTextSchema()`
3. Add comprehensive unit tests
4. Update JSDoc documentation

**Example:**
```typescript
// In dal/lib/ml-string.ts
export interface MlStringSchemaOptions {
  maxLength?: number;
  array?: boolean;
  allowHTML?: boolean;  // NEW - defaults to true
}

const mlString = {
  getSchema({ maxLength, array = false, allowHTML = true }: MlStringSchemaOptions = {}) {
    // ... existing validation ...

    // NEW: HTML validation
    if (!allowHTML && typeof langValue === 'string') {
      const stripped = stripTags(langValue);
      if (stripped !== langValue) {
        throw new ValidationError(
          `Plain text field for language '${langKey}' contains HTML tags. ` +
          `Use stripHTML() to sanitize.`
        );
      }
    }

    // ... rest of validation ...
  },

  getSafeTextSchema(opts = {}) {
    return this.getSchema({ ...opts, allowHTML: false });
  },

  getHTMLSchema(opts = {}) {
    return this.getSchema({ ...opts, allowHTML: true });
  },

  getRichTextSchema() {
    const objectType = types.object();
    objectType.validator(value => {
      if (value === null || value === undefined) return true;
      const record = value as Record<string, unknown>;
      if (record.text !== undefined) {
        this.getSafeTextSchema().validate(record.text, 'rich text .text field');
      }
      if (record.html !== undefined) {
        this.getHTMLSchema().validate(record.html, 'rich text .html field');
      }
      return true;
    });
    return objectType;
  },
};
```

**Tests:**
```typescript
describe('mlString.getSafeTextSchema', () => {
  it('accepts plain text', () => {
    const schema = mlString.getSafeTextSchema();
    expect(() => schema.validate({ en: 'Hello' })).not.toThrow();
  });

  it('rejects HTML', () => {
    const schema = mlString.getSafeTextSchema();
    expect(() => schema.validate({ en: '<p>Hello</p>' }))
      .toThrow('contains HTML tags');
  });
});
```

**Files:**
- `dal/lib/ml-string.ts` - Implementation
- `dal/lib/ml-string.test.ts` - Tests (new file)

**Commit message:** `feat(ml-string): add runtime HTML validation with permissive default`

✅ All existing tests pass (behavior unchanged)

---

### Phase 2: Add Template Helpers

**Goal**: Add new helpers without changing existing templates.

**Changes:**
1. Add `mlSafeText` helper (auto-escapes)
2. Add `mlHTML` helper (no escaping)
3. Keep `mlString` unchanged

**Example:**
```typescript
// In util/handlebars-helpers.ts

hbs.registerHelper('mlSafeText', (...args) => {
  const [str, addLanguageSpan, options] =
    args.length === 2 ? [args[0], true, args[1]] :
    [args[0], args[1] as boolean, args[2]];

  const context = getTemplateContext(options);
  const mlRv = resolveMultilingual(context.locale, str);

  if (!mlRv?.str) return undefined;

  const escaped = escapeHTML(mlRv.str);

  if (!addLanguageSpan || mlRv.lang === context.locale || mlRv.lang === 'und') {
    return new SafeString(escaped);
  }

  const languageName = languages.getCompositeName(mlRv.lang, context.locale);
  return new SafeString(
    `${escaped} <span class="language-identifier" title="${languageName}">` +
    `<span class="fa fa-fw fa-globe">&nbsp;</span>${mlRv.lang}</span>`
  );
});

hbs.registerHelper('mlHTML', (...args) => {
  const [str, addLanguageSpan, options] =
    args.length === 2 ? [args[0], false, args[1]] :
    [args[0], args[1] as boolean, args[2]];

  const context = getTemplateContext(options);
  const mlRv = resolveMultilingual(context.locale, str);

  if (!mlRv?.str) return undefined;

  // No escaping - content is pre-rendered HTML
  if (!addLanguageSpan || mlRv.lang === context.locale || mlRv.lang === 'und') {
    return new SafeString(mlRv.str);
  }

  const languageName = languages.getCompositeName(mlRv.lang, context.locale);
  return new SafeString(
    mlRv.str +
    ` <span class="language-identifier" title="${languageName}">` +
    `<span class="fa fa-fw fa-globe">&nbsp;</span>${mlRv.lang}</span>`
  );
});

// Keep existing mlString helper unchanged
```

**Files:**
- `util/handlebars-helpers.ts` - Add new helpers

**Commit message:** `feat(templates): add mlSafeText and mlHTML helpers for explicit escaping`

✅ All existing tests pass (no templates use new helpers yet)

---

### Phase 3: Migrate Templates

**Goal**: Switch all templates to explicit helpers.

**Critical**: This MUST happen before schema migration to avoid double-escaping.

**Changes:**
Replace all `mlString` usage across 22 template files:

```handlebars
{{!-- Plain text fields --}}
Before: {{{mlString review.title}}}
After:  {{mlSafeText review.title}}

Before: {{{mlString team.name}}}
After:  {{mlSafeText team.name}}

Before: {{{mlString thing.label}}}
After:  {{mlSafeText thing.label}}

{{!-- HTML fields --}}
Before: {{{mlString review.html false}}}
After:  {{{mlHTML review.html}}}

Before: {{{mlString team.description.html false}}}
After:  {{{mlHTML team.description.html}}}

{{!-- Markdown source (plain text) --}}
Before: {{{mlString formValues.text false}}}
After:  {{mlSafeText formValues.text false}}
```

**Migration Pattern:**
- `.html` field → `mlHTML`
- `.text` field → `mlSafeText`
- `.title`, `.name`, `.label`, `.motto` → `mlSafeText`
- Everything else → `mlSafeText` (default to safe)

**Template Groups:**
1. Review templates (9 files): review.hbs, review-form.hbs, partials/review.hbs, etc.
2. Team templates (5 files): team.hbs, team-form.hbs, teams.hbs, etc.
3. Thing templates (3 files): thing.hbs, thing-form.hbs, search.hbs
4. User & Blog templates (4 files): user.hbs, blog-post.hbs, etc.
5. Utility templates (3 files): index.hbs, files.hbs, partials/uploads.hbs
6. Feed templates (2 files): blog-feed-atom.hbs, partials/feed-atom.hbs

**Testing:**
- Visual inspection of all pages
- Verify HTML escaping with browser dev tools
- Test with XSS payloads in plain text fields

**Files:**
- All 22 `.hbs` files in `views/`

**Commit message:** `refactor(templates): migrate from mlString to mlSafeText/mlHTML for explicit escaping`

✅ All tests pass (templates now handle escaping, schemas still permissive)

---

### Phase 4: Migrate Schemas to Strict Mode

**Goal**: Enforce validation at database write time.

**Now safe because**: Templates already handle escaping correctly from Phase 3.

**Changes:**
Update all model manifests to use explicit schema methods:

**Group A: Plain Text Fields**
```typescript
// models/manifests/team.ts
name: mlString.getSafeTextSchema({ maxLength: 100 }),
motto: mlString.getSafeTextSchema({ maxLength: 200 }),

// models/manifests/thing.ts
label: mlString.getSafeTextSchema({ maxLength: 256 }),

// models/manifests/review.ts
title: mlString.getSafeTextSchema({ maxLength: 255 }),

// models/manifests/blog-post.ts
title: mlString.getSafeTextSchema({ maxLength: 100 }),

// models/manifests/file.ts
description: mlString.getSafeTextSchema(),
creator: mlString.getSafeTextSchema(),
source: mlString.getSafeTextSchema(),
```

**Group B: Rich Text Sibling Fields**
```typescript
// models/manifests/review.ts
text: mlString.getSafeTextSchema(),
html: mlString.getHTMLSchema(),

// models/manifests/blog-post.ts
text: mlString.getSafeTextSchema(),
html: mlString.getHTMLSchema(),
```

**Group C: Rich Text Nested Fields**
```typescript
// models/manifests/team.ts
description: mlString.getRichTextSchema(),
rules: mlString.getRichTextSchema(),

// models/manifests/user-meta.ts
bio: mlString.getRichTextSchema(),
```

**Group D: Array Fields**
```typescript
// models/manifests/thing.ts
aliases: mlString.getSafeTextSchema({ maxLength: 256, array: true }),
// In metadata virtual getter
authors: mlString.getSafeTextSchema({ maxLength: 256, array: true }),
```

**Testing:**
- Run full test suite
- Test creating records with plain text (should work)
- Test creating records with HTML in plain text fields (should fail with clear error)

**Files:**
- `models/manifests/team.ts`
- `models/manifests/thing.ts`
- `models/manifests/review.ts`
- `models/manifests/blog-post.ts`
- `models/manifests/file.ts`
- `models/manifests/user-meta.ts`

**Commit message:** `feat(models): enforce runtime HTML validation in multilingual schemas`

✅ All tests pass (validation enforced, templates already correct)

---

### Phase 5: Finalize & Cleanup

**Goal**: Make strict validation the default, add error handling, and remove old code.

**Changes:**
1. Change `allowHTML` default from `true` to `false` in `getSchema()`
2. Remove `mlString` helper entirely (templates already migrated)
3. Remove `validateTextHtmlObject()` from team.ts (replaced by getRichTextSchema)
4. Add user-friendly error handling for validation failures
5. Add integration tests

**Example:**
```typescript
// dal/lib/ml-string.ts
function getSchema({
  maxLength,
  array = false,
  allowHTML = false  // Changed from true to false
}: MlStringSchemaOptions = {}) {
  // ...
}

// util/handlebars-helpers.ts
// Remove mlString helper entirely (templates already use mlSafeText/mlHTML)

// models/manifests/team.ts
// Remove validateTextHtmlObject function (now unused)

// In route handlers - add error handling
try {
  await review.save();
} catch (err) {
  if (err instanceof ValidationError && err.message.includes('contains HTML tags')) {
    req.flash('errors', req.__('plain text field cannot contain html'));
    return res.redirect('back');
  }
  throw err;
}
```

**Integration Tests:**
```typescript
describe('Validation error handling', () => {
  it('rejects HTML in plain text field', async () => {
    const thing = new Thing({
      label: { en: '<script>alert("xss")</script>' },
      createdBy: user.id,
    });
    await expect(thing.save()).rejects.toThrow('contains HTML tags');
  });

  it('accepts HTML in html field', async () => {
    const review = new Review({
      title: { en: 'Title' },
      text: { en: 'Content' },
      html: { en: '<p>Content</p>' },
      starRating: 5,
      thingID: thing.id,
      createdBy: user.id,
    });
    await expect(review.save()).resolves.toBeDefined();
  });
});
```

**Files:**
- `dal/lib/ml-string.ts` - Change default
- `util/handlebars-helpers.ts` - Remove `mlString` helper
- `models/manifests/team.ts` - Remove old validator
- `routes/handlers/*.ts` - Add error handling
- `tests/integration/*.ts` - Add validation tests

**Commit message:** `feat: finalize mlString type safety with strict validation and cleanup`

✅ All tests pass (strict validation, clean codebase)

---

## Adoption Pattern for Future Development

Once implementation is complete, use these patterns:

### Creating New Models

```typescript
const myManifest = defineModelManifest({
  schema: {
    // Plain text
    name: mlString.getSafeTextSchema({ maxLength: 100 }),

    // Array of plain text
    tags: mlString.getSafeTextSchema({ array: true }),

    // Rich text (nested)
    description: mlString.getRichTextSchema(),

    // Rich text (sibling fields)
    text: mlString.getSafeTextSchema(),
    html: mlString.getHTMLSchema(),
  }
});
```

### Writing Templates

```handlebars
{{!-- Plain text (auto-escaped) --}}
<h1>{{mlSafeText review.title}}</h1>

{{!-- HTML (pre-rendered markdown) --}}
<div>{{{mlHTML review.html}}}</div>

{{!-- Suppress language indicator --}}
<meta content="{{mlSafeText thing.label false}}" />
```

### Processing External Data

```typescript
// In adapters
const label = mlString.stripHTML({
  en: externalData.title,
  es: externalData.titulo,
});
```

### Handling Validation Errors

```
ValidationError: Plain text field for language 'en' contains HTML tags.
```

**Fix:** Apply `mlString.stripHTML()` or use `getHTMLSchema()` if it's legitimately HTML.

## Security Benefits

**Defense in Depth:**
1. Input sanitization (adapters/forms)
2. Runtime validation (schema layer) ← NEW
3. Template escaping (mlSafeText helper) ← NEW
4. Type system (future: branded types)

Even if one layer fails, others catch it.

## Testing Strategy

### Unit Tests
- Plain text schema rejects HTML
- HTML schema allows HTML
- Rich text schema validates both fields
- Clear error messages

### Integration Tests
- Create records with valid data
- Create records with HTML in plain text (fails)
- Form submission works correctly
- Adapters pass validation

### Security Tests
- XSS payloads rejected in plain text fields
- Template rendering escapes correctly
- HTML rendering works for markdown

## Performance Impact

- **Runtime cost**: ~0.1ms per field validation (only on writes)
- **Memory cost**: None (schema objects reused)
- **Database impact**: None (no schema changes)

## Rollback Plan

Each phase can be reverted independently:
- **Phase 1-2**: Revert, no impact (APIs unused)
- **Phase 3**: Revert templates, keep using `mlString`
- **Phase 4+**: Revert schemas, set `allowHTML: true` default

**Emergency**: Set `DISABLE_HTML_VALIDATION=true` environment variable to bypass validation.

## Implementation Notes

### Slug Generation
When generating URL slugs from HTML-safe text fields, must decode entities first to avoid slugs like `a-amp-b` from `A&amp;B`. Use `decodeHTML()` before slug generation:
```typescript
const slug = generateSlug(decodeHTML(mlString.resolve('en', thing.label)));
// "A&B" → "a-b" ✓
// Not: "A&amp;B" → "a-amp-b" ✗
```

### Terminology
- **HTML-safe text**: Text with entities escaped (`&amp;`, `&lt;`, etc.) but preserving user's literal content
- **Plain text**: Decoded text for non-HTML contexts (use `decodeHTML()`)
- Consider `mlSafeText` as alternative helper name to make safety model explicit

## Related Files

### Core
- `dal/lib/ml-string.ts` - Type definitions and validation
- `util/handlebars-helpers.ts` - Template helpers

### Models
- `models/manifests/review.ts`, `blog-post.ts`, `team.ts`, `thing.ts`, `user-meta.ts`, `file.ts`

### Templates
- 22 files in `views/` directory

### Form Processing
- `routes/helpers/forms.ts`
- `routes/handlers/review-provider.ts`, `blog-post-provider.ts`, `team-provider.ts`, `user-handlers.ts`, `things.ts`

### Adapters
- `adapters/wikidata-backend-adapter.ts`, `openlibrary-backend-adapter.ts`, `openstreetmap-backend-adapter.ts`

## Future Improvements

### Phase 5: Entity Escaping Runtime Guards (Post-Merge)

**Goal**: Add runtime validation to enforce that all text stored in HTML-safe text fields has entities properly escaped.

**Prerequisites**:
- All phases 1-4 complete and merged
- All existing data verified to be conformant to HTML-safe text format
- Data migration run if needed to normalize legacy content

**Changes:**

Add validation to `getSafeTextSchema()` to reject improperly escaped text:

```typescript
// In dal/lib/ml-string.ts

// Check for unescaped entities
function hasUnescapedEntities(value: string): boolean {
  // Detect bare ampersands not part of entity references
  if (/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/i.test(value)) {
    return true;
  }

  // Detect unescaped angle brackets (< should be &lt;)
  if (/</.test(value)) {
    return true;
  }

  return false;
}

getSafeTextSchema(options: MlStringPlainTextSchemaOptions = {}): ObjectType {
  // ... existing code ...

  schema = schema.test(
    'properly-escaped',
    'Text must have HTML entities properly escaped',
    function(mlStr: MultlingualString | undefined) {
      if (!mlStr) return true;

      for (const lang in mlStr) {
        const value = mlStr[lang];
        if (typeof value === 'string' && hasUnescapedEntities(value)) {
          return this.createError({
            message: `Text in language '${lang}' contains unescaped entities. ` +
                     `Example: use '&amp;' not '&', use '&lt;' not '<'`,
            path: this.path,
          });
        }
      }

      return true;
    }
  );

  return schema;
}
```

**Benefits:**
- Enforces the HTML-safe text contract at the type system level
- Catches bugs where text is stored without proper escaping
- Makes the "escape on write" model explicit and verifiable
- Aligns validation completely with the spec

**Rollout:**
1. Add validation with opt-in flag initially for testing
2. Run validation against all existing data to identify non-conformant records
3. Migrate any non-conformant data (likely minimal after phase 4)
4. Enable validation by default
5. Remove opt-in flag in future commit

**Commit message:** `feat(ml-string): add runtime guards for entity escaping in HTML-safe text`

## References

- Original plan (superseded): Earlier version of this document
- OWASP XSS Prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
