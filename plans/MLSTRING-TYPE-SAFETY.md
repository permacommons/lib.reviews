# Multilingual String Type Safety Improvements

**Status**: Preliminary observations
**Created**: 2025-11-11
**Context**: Double-escaping bug investigation revealed broader type safety issues

## Problem Statement

The current multilingual string system relies on naming conventions and developer knowledge rather than type safety to distinguish between plain text and HTML content. This creates opportunities for XSS vulnerabilities and makes the codebase harder to understand for new developers.

## Current State Analysis

### Existing Type Definitions

Located in `dal/lib/ml-string.ts`:

```typescript
// Line 11 - Basic multilingual string (language code -> string)
type MultilingualString = Record<string, string>;

// Line 13 - Array variant
type MultilingualStringArray = Record<string, string[]>;

// Line 25 - Rich text structure with both markdown source and rendered HTML
export interface MultilingualRichText {
  text?: MultilingualString;
  html?: MultilingualString;
}

// Line 30 - Union type accepting any of the above
export type MultilingualInput =
  | MultilingualString
  | MultilingualStringArray
  | MultilingualRichText
  | null
  | undefined;
```

### Current Usage Patterns

**Pattern 1: Plain Text Fields** (stored directly as `MultilingualString`)
- `thing.label` - Labels from external adapters (OSM, Wikidata, OpenLibrary)
- `thing.metadata.subtitle` - Subtitles for things
- `thing.metadata.authors` - Author names (array of MultilingualString)
- `team.name` - Team names
- `team.motto` - Team mottos
- `review.title` - Review titles

**Pattern 2: Rich Text Fields** (stored as `MultilingualRichText` with `.text` and `.html`)
- `team.description.text` / `team.description.html`
- `team.rules.text` / `team.rules.html`
- `user.meta.bio.text` / `user.meta.bio.html`

**Pattern 3: Sibling Fields** (exception: separate fields instead of nested object)
- `review.text` - Markdown source
- `review.html` - Rendered HTML

### Schema Definition

All multilingual fields use the same schema method:
```typescript
mlString.getSchema({ maxLength?: number, array?: boolean })
```

This returns an `ObjectType` that validates structure but **doesn't distinguish between plain text and HTML content**.

### Validation

For Pattern 2 (rich text), there's a custom validator in `models/manifests/team.ts`:

```typescript
function validateTextHtmlObject(value: unknown): boolean {
  if (value === null || value === undefined) return true;

  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Description/rules must be an object with text and html properties');

  const record = value as Record<string, unknown>;
  if (record.text !== undefined) mlString.validate(record.text);
  if (record.html !== undefined) mlString.validate(record.html);

  return true;
}
```

This validates structure but still treats both `.text` and `.html` identically.

## Issues with Current Design

### 1. No Type Distinction Between Plain Text and HTML

```typescript
// Both are valid TypeScript, but semantically wrong:
thing.label = { en: '<script>alert("xss")</script>' }; // Should be plain text!
review.html = { en: 'Plain text here' }; // Should be rendered HTML!
```

### 2. Template Rendering is Unsafe

The `mlString` Handlebars helper (in `util/handlebars-helpers.ts:202-225`) doesn't distinguish between content types:

```typescript
hbs.registerHelper('mlString', (...args) => {
  // ... resolves the multilingual string ...
  return mlRv.str; // Returns raw string without escaping
});
```

All templates use triple braces (unescaped output):
```handlebars
{{{mlString thing.label}}}        <!-- Plain text, should be escaped! -->
{{{mlString review.html}}}         <!-- HTML, correctly unescaped -->
{{{mlString team.description.html}}} <!-- HTML, correctly unescaped -->
```

### 3. Adapter Output is Ambiguous

Adapters return `AdapterMultilingualString` which is just an alias:

```typescript
// In adapters/abstract-backend-adapter.ts
export type AdapterMultilingualString = Record<string, string>;
```

There's no indication that this MUST be plain text only (no HTML).

### 4. Data Flow Lacks Sanitization Checkpoints

Before the recent fix, the data flow was:
1. External API → Adapter (no sanitization)
2. Adapter → Database (stored as-is)
3. Database → Template (rendered unescaped)

After the fix (2025-11-11):
1. External API → Adapter (**now sanitized**: `stripTags(decodeHTML(value))`)
2. Adapter → Database (plain text only)
3. Database → Template (still rendered unescaped)

But there's no type enforcement ensuring step 1 happens correctly.

## Proposed Improvements

### Phase 1: Distinct Types

```typescript
// Brand types to prevent mixing
type PlainTextBrand = { __plaintext: never };
type HTMLBrand = { __html: never };

export type MultilingualPlainText = Record<string, string> & PlainTextBrand;
export type MultilingualHTML = Record<string, string> & HTMLBrand;

// Rich text structure
export interface MultilingualRichText {
  text: MultilingualPlainText;
  html: MultilingualHTML;
}
```

### Phase 2: Separate Schema Methods

```typescript
mlString.getPlainTextSchema({ maxLength?: number }); // Returns branded type
mlString.getRichTextSchema({ maxLength?: number });  // Returns RichText structure
mlString.getPlainTextArraySchema({ maxLength?: number }); // For authors, aliases
```

### Phase 3: Separate Handlebars Helpers

```typescript
// Auto-escapes plain text for XSS protection
hbs.registerHelper('mlText', (mlText: MultilingualPlainText) => {
  const resolved = resolveMultilingual(context.locale, mlText);
  return new SafeString(escapeHTML(resolved.str));
});

// Renders pre-sanitized HTML without escaping
hbs.registerHelper('mlHTML', (mlHtml: MultilingualHTML) => {
  const resolved = resolveMultilingual(context.locale, mlHtml);
  return new SafeString(resolved.str);
});
```

### Phase 4: Adapter Type Enforcement

```typescript
export interface AdapterLookupData {
  // Only plain text allowed from adapters
  label?: MultilingualPlainText;
  subtitle?: MultilingualPlainText;
  authors?: MultilingualPlainText[];
  description?: MultilingualPlainText;
}
```

## Migration Strategy

1. **Add new types without breaking changes** - Introduce branded types as aliases initially
2. **Update adapters first** - They're the entry points, enforce plain text output
3. **Update models** - Change schema definitions to use new methods
4. **Add new Handlebars helpers** - Keep old `mlString` for backwards compatibility
5. **Update templates incrementally** - Convert `{{{mlString}}}` to `{{mlText}}` or `{{mlHTML}}`
6. **Deprecate old helper** - After all templates migrated
7. **Remove brand compatibility** - Make types strictly incompatible

## Security Benefits

- **Defense in depth**: Multiple layers preventing XSS
- **Compile-time safety**: TypeScript catches misuse
- **Self-documenting**: Types communicate intent
- **Harder to make mistakes**: Wrong usage won't compile

## Developer Experience Benefits

- Clear distinction between plain text and HTML in code
- IDE autocomplete helps choose correct helper
- Type errors catch bugs during development
- New developers don't need to memorize conventions

## Open Questions

1. Should we use branded types or nominal types (classes)?
2. How to handle migration of existing data in database?
3. Should markdown rendering create a new branded type `MultilingualMarkdown`?
4. Performance impact of additional type checking?
5. How to handle edge cases like JSON-LD in templates (line 112-114 in views/thing.hbs)?

## Related Files

- `dal/lib/ml-string.ts` - Core type definitions
- `util/handlebars-helpers.ts` - Template rendering (mlString helper at line 202-225)
- `adapters/*-backend-adapter.ts` - Data sources (now sanitize with stripTags/decodeHTML)
- `models/manifests/*.ts` - Schema definitions
- `views/**/*.hbs` - Template files using `{{{mlString}}}`

## See Also

- Recent fix for double-escaping bug (commit removing escapeHTML from adapters)
- Issue with slug generation from labels containing HTML tags
