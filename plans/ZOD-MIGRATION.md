# Form Parser Migration to Zod

## Background

The current form parsing system (`routes/helpers/forms.ts`) uses a custom `FormField[]` schema format with runtime validation and type transformations. While functional, it has several limitations:

1. **Dual maintenance**: Schema definitions (`FormField[]`) and types are separate, leading to potential drift
2. **Limited type inference**: Returns `Record<string, unknown>` requiring manual type narrowing at call sites
3. **Complex type transformations**: Different `type` values produce different output shapes that aren't reflected in static types
4. **Custom validation logic**: Homegrown validation that could benefit from battle-tested library

## Why Zod?

[Zod](https://zod.dev/) is the most popular TypeScript schema validation library:

- **Single source of truth**: Schema definition generates both runtime validation AND static types
- **Type inference**: `z.infer<typeof schema>` automatically derives TypeScript types
- **Composable**: Schemas can be reused, extended, and composed
- **Great DX**: Excellent error messages, IDE autocomplete
- **Widely adopted**: 30k+ GitHub stars, used by Next.js, tRPC, many others
- **Small bundle**: ~8kb minified + gzipped

## Migration Strategy

### Phase 1: Add Zod, Create Utilities (Low Risk) ✅

1. Installed Zod dependency (`zod`).
2. Created `routes/helpers/zod-forms.ts` with utilities:
   - `createMultilingualTextField(language)` - validates the language key and returns escaped `{ [language]: string }`
   - `createMultilingualMarkdownField(language, renderLocale?)` - builds `{ text, html }` with escaped text and localized markdown rendering
   - CSRF helpers: `csrfField`, `csrfSchema`
   - CAPTCHA helper: `createCaptchaSchema(formKey, translate?)` (config-aware, localized answer validation)
3. No changes to existing runtime behaviour yet

### Phase 2: Migrate One Form (Proof of Concept) ✅

Pick a simple form to prove the pattern works:
- Candidate: **User registration form** (`routes/actions.ts` - only 5 fields)
- Added `buildRegisterSchema` with CSRF, email normalization, and config-aware CAPTCHA wiring
- Registration POST handlers now rely on Zod-only validation (legacy parsing removed for this route); errors reuse existing i18n keys, and typed data drives `User.create`
- DX: typed `RegisterForm` improves autocomplete; optional CAPTCHA handled via shared helper; localized messages reused via `req.__`

### Phase 3: Incremental Migration

Migrate forms one at a time, starting with simpler ones:

**Simple forms** (few fields, straightforward validation):
- User registration ✅
- Team creation ✅ (new/edit handlers now Zod-first)
- Blog post creation ✅ (new/edit via blog post provider)
- Thing URL management ✅

**Medium complexity** (conditional logic, nested structures):
- Review creation ✅ (conditional team fields, multilingual content, previews)

**Complex forms** (dynamic fields, multi-file uploads):
- Multi-file upload with per-file metadata ✅ (stage 2 metadata form now Zod-only)
- Thing editing ✅ (dynamic field names via computed properties)

**Delete operations:**
- Review deletion ✅ (migrated to Zod with checkbox handling)

### Phase 4: Deprecate Old System

Once all forms migrated:
1. Remove `routes/helpers/forms.ts`
2. Remove `FormField` type and related helpers
3. Update documentation

## Example: Before & After

### Current Approach

```typescript
// routes/actions.ts
const formDefs: Record<string, FormField[]> = {
  register: [
    { name: 'username', required: true },
    { name: 'password', required: true },
    { name: 'email', required: false },
  ],
};

// In handler
const formInfo = forms.parseSubmission(req, {
  formDef: formDefs.register,
  formKey: 'register',
});

// Manual type narrowing required
const username = formInfo.formValues.username as string;
const password = formInfo.formValues.password as string;
```

### With Zod

```typescript
import { z } from 'zod';

const registerSchema = z.object({
  _csrf: z.string(),
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  email: z.string().email().optional(),
});

type RegisterForm = z.infer<typeof registerSchema>;
//   ^? { _csrf: string; username: string; password: string; email?: string }

// In handler
const result = registerSchema.safeParse(req.body);
if (!result.success) {
  // result.error.issues has detailed, typed errors
  const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
  req.flash('pageErrors', errors);
  return;
}

// result.data is fully typed!
const { username, password, email } = result.data;
```

## Handling Current Form Patterns

### Pattern 1: Multilingual Text Fields

**Current**: `type: 'text'` → `{ [language]: string }`

**With Zod**:
```typescript
const createMultilingualText = (language: string) =>
  z.object({ [language]: z.string() });

// Or accept pre-localized input
const reviewSchema = z.object({
  title: z.string().transform((val, ctx) => ({
    [ctx.locale]: val  // assuming we pass locale in context
  }))
});
```

### Pattern 2: Markdown with HTML Generation

**Current**: `type: 'markdown'` → `{ text: { [lang]: string }, html: { [lang]: string } }`

**With Zod**:
```typescript
const createMarkdownField = (language: string, markdownRenderer: typeof md) =>
  z.string().transform(val => ({
    text: { [language]: escapeHTML(val) },
    html: { [language]: markdownRenderer.render(val) }
  }));
```

### Pattern 3: Field Name Remapping

**Current**: `{ name: 'review-url', key: 'url' }`

**With Zod**:
```typescript
const schema = z.object({
  'review-url': z.string().url()
}).transform(data => ({
  url: data['review-url']  // explicit remapping
}));
```

### Pattern 4: CAPTCHA Integration

**Current**: Auto-added based on `formKey`

**With Zod**:
```typescript
const withCaptcha = <T extends z.ZodObject<any>>(schema: T, formKey: string) => {
  const config = getCaptchaConfig(formKey);
  if (!config) return schema;

  return schema.extend({
    'captcha-id': z.string(),
    'captcha-answer': z.string()
  }).refine(data => validateCaptcha(data['captcha-id'], data['captcha-answer']), {
    message: 'Incorrect CAPTCHA answer'
  });
};
```

## Open Questions

1. **Language handling**: How do we pass locale context to Zod transforms?
   - Option A: Use Zod context (`ctx`) in transforms
   - Option B: Create schema factories that accept language parameter
   - Option C: Post-process Zod output with language transformation

2. **Flash message integration**: Zod error format vs. current flash message pattern
   - Current: `req.flash('pageErrors', req.__('need username'))`
   - Zod: Structured errors with paths and messages
   - Need: Helper to convert Zod errors → localized flash messages

3. **CSRF validation**: Currently auto-injected in `parseSubmission`
   - Should we make CSRF validation explicit in each schema?
   - Or create a wrapper that auto-adds CSRF?

4. **Form re-rendering with errors**: Current code passes `formValues` back to template
   - How do we preserve submitted (invalid) values for re-display?
   - Zod provides both the error and the original input

## Success Criteria

Migration is successful if:
- ✅ All forms have type-safe validation
- ✅ No more `Record<string, unknown>` form values
- ✅ Reduced code duplication between schema and types
- ✅ Better error messages for users
- ✅ Easier to add new forms (less boilerplate)
- ✅ Type checker catches form validation errors at compile time

## Resources

- [Zod Documentation](https://zod.dev/)
- [Zod GitHub](https://github.com/colinhacks/zod)
- [Comparison with other libraries](https://zod.dev/?id=comparison)

## Worklog

- 2025-11-26: Installed `zod` and added `routes/helpers/zod-forms.ts` with multilingual text/markdown helpers plus CSRF and CAPTCHA schemas.
- 2025-11-26: Added `buildRegisterSchema` and switched /register handlers to Zod-only validation; errors reuse existing message keys and parsed data feeds `User.create`.
- 2025-11-26: Added CSRF error handling middleware to surface friendly 403 responses (HTML + JSON) instead of uncaught exceptions when tokens are missing/invalid; uses dedicated title/detail keys for the standard permission error page.
- 2025-11-26: Added `flashZodIssues` helper and refactored /register to use it for flashing Zod validation errors without per-handler loops.
- 2025-11-26: Migrated team creation/edit routes to Zod schemas (multilingual text/markdown, boolean flags, CAPTCHA, CSRF) and removed legacy `FormField` definitions; handlers now flash Zod issues and re-render with sanitized values.
- 2025-11-26: Added shared Zod form helpers (language validation, safe parsing, consistent error messaging) colocated with `flashZodIssues`; migrated team blog add/edit routes to Zod (multilingual text/markdown, CSRF/CAPTCHA, preview support) and removed legacy `FormField` parsing for blog posts.
- 2025-11-26: Migrated thing URL management to Zod with strict schema validation, normalized URL handling, and consistent flash messaging while preserving primary/duplicate checks.
- 2025-11-26: Migrated review creation/edit flows to Zod with URL validation, multilingual text/markdown rendering, integer star ratings, team/file/social-image handling, and preview-safe flashing.
- 2025-11-26: Preview parity fixes: set `isPreview` before validation (matching teams/blog) and carry creator/createdOn into preview re-renders on validation errors so bylines remain populated even with empty inputs.
- 2025-11-26: Migrated stage 2 of multi-file uploads (metadata form) to Zod with language, CSRF, and per-upload validation (description/creator/source/license) plus sanitized multilingual fields; redirects and flashes reuse legacy messages while keeping stage 1 streaming unchanged.
- 2025-11-28: Migrated review deletion to Zod with checkbox preprocessing for `delete-thing` field (handles HTML checkbox behavior where unchecked = absent), CSRF validation, and consistent error flashing; removed `ReviewProvider.formDefs` and `FormField` import from review-provider.ts.
- 2025-11-28: Migrated thing field editing to Zod with dynamic field names via computed properties (`thing-${field}`), inline language validation via `superRefine`, and automatic HTML escaping; replaced manual type guards and InvalidLanguageError catch handling with upfront Zod validation in `processTextFieldUpdate`.
