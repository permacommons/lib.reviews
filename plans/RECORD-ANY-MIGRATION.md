# Record<string, any> Migration Notes

Tracking the migration of loose `Record<string, any>` types to specific interfaces
in route handlers and providers.

## Priority: Model Casts in Providers

### `routes/handlers/review-provider.ts`

**Current Issues:**

| Line | Code | Issue |
|------|------|-------|
| 24-32 | Local `ThingInstance` type | Duplicates `models/manifests/thing.ts` |
| 50-65 | Local `ReviewInstance` type | Duplicates `models/manifests/review.ts` |
| 47 | `[key: string]: any;` in ReviewFormValues | Makes entire type loose |
| 70 | `static formDefs: Record<string, any>` | Could use FormFieldDefinition[] |

**Available Typed Exports:**

- `ReviewModel`, `ReviewInstance` from `models/manifests/review.ts`
- `UserModel`, `UserInstance`, `UserView` from `models/manifests/user.ts`
- `FileModel`, `FileInstance` from `models/manifests/file.ts`
- `ThingInstance` from `models/manifests/thing.ts`
- `TeamInstance` from `models/manifests/team.ts`

#### Analysis: ReviewFormValues/ReviewInstance Conflation

The local `ReviewFormValues` type conflates two distinct concepts:

1. **Raw form input** - data from `parseForm()`:
   - `teams` as `string[]` (UUIDs from form checkboxes)
   - `files` as `string[]` (UUIDs of uploaded files)
   - Other form fields as parsed strings/values

2. **Resolved/persisted data** - after processing:
   - `teams` as `TeamInstance[]` (resolved by `resolveTeamData()`)
   - Files resolved via `File.getMultipleNotStaleOrDeleted()`

**Current flow:**
```
parseForm() → formValues (teams: string[])
     ↓
resolveTeamData() mutates formValues.teams → TeamInstance[]
     ↓
File.getMultipleNotStaleOrDeleted(formValues.files)
     ↓
Review.create(reviewObj, ...)
```

The `[key: string]: any` index signature was added to paper over this type mismatch
rather than properly separating concerns.

**Migration Plan:**

1. [x] Remove `as any` casts - use models directly (already typed)
   - Models are already typed at export (`as ReviewModel`, etc.) - just use them directly
   - No need for intermediate aliases - `Review`, `User`, `File`, `Team` work as-is
   - Added explicit casts at type boundaries (e.g., `as unknown as ReviewInstance`)
   - This reveals where local types diverge from manifest types

2. [ ] Import `ThingInstance` from manifest instead of local definition
   - [ ] Add import: `import type { ThingInstance } from '../../models/manifests/thing.ts'`
   - [ ] Remove local `ThingInstance` type (lines 24-32)
   - [ ] Fix any type mismatches that surface

3. [ ] Separate form input from model instance types
   - [ ] Create `ReviewFormInput` for raw form data:
     ```typescript
     type ReviewFormInput = {
       title?: Record<string, string>;
       text?: Record<string, string>;
       starRating?: number;
       teams?: string[];           // UUIDs from form
       files?: string[];           // UUIDs from form
       socialImageID?: string;
       originalLanguage?: string;
       // ... other form fields
     };
     ```
   - [ ] Import `ReviewInstance` from manifest for resolved/persisted data
   - [ ] Remove local `ReviewInstance` type (lines 50-65)
   - [ ] Update `resolveTeamData()` signature to transform types properly
   - [ ] Consider immutable transform pattern instead of mutation:
     ```typescript
     async resolveTeamData(input: ReviewFormInput): Promise<ResolvedReviewData>
     ```

4. [ ] Remove `[key: string]: any` index signature
   - [ ] Add any missing explicit fields to `ReviewFormInput`
   - [ ] Fix call sites that relied on loose typing

5. [ ] Type `formDefs` properly
   - [ ] Use `FormFieldDefinition[]` from shared types (see below)

---

### `routes/handlers/team-provider.ts`

**Current Issues:**

| Line | Code | Issue |
|------|------|-------|
| 19-37 | Local `TeamInstance` with `Record<string, any>` | Loose typing for members/moderators/etc |
| 38 | `type TeamFormValues = Record<string, any>;` | Completely untyped |
| 41 | `static formDefs: Record<string, any>` | Could use FormFieldDefinition[] |
| 550, 553 | `this.req.user as Record<string, any>` | Should use UserInstance |

**Migration Plan:**

1. [x] Remove `as any` casts - BlogPost now imported directly
2. [ ] Tighten local `TeamInstance` - replace `Record<string, any>` with specific types
3. [ ] Type `TeamFormValues` with explicit fields
4. [ ] Replace `req.user as Record<string, any>` with UserInstance

---

### `routes/handlers/user-handlers.ts`

**Current Issues:**

| Line | Code | Issue |
|------|------|-------|
| 51 | `(metaRev.bio as Record<string, any>)` | Could use proper bio typing from UserMetaInstance |

**Migration Plan:**

1. [x] Remove `as any` casts - models imported directly
2. [x] Type bioObj inline (now properly typed)
3. [ ] Type metaRev.bio properly - define Bio type or use UserMetaInstance

---

## Priority: Form/Request Body Types

### `routes/helpers/forms.ts`

| Line | Code | Notes |
|------|------|-------|
| 48 | `formValues: Record<string, any>` in ParseSubmissionResult | Core form helper |
| 86 | `const formValues: Record<string, any> = {}` | Runtime accumulator |

**Challenge:** Form values are dynamically built based on formDef. Options:
- Generic `ParseSubmissionResult<T>` where T extends form schema
- Keep `Record<string, unknown>` (safer than `any`)
- Type-narrow at call sites

### `routes/handlers/api-upload-handler.ts`

| Line | Code | Notes |
|------|------|-------|
| 33 | Request body `Record<string, any>` | Upload metadata |
| 109, 145, 194, 228, 253, 257 | Various `Record<string, any>` params | Metadata validation/handling |

**Potential type:**
```typescript
interface UploadMetadata {
  multiple?: boolean;
  description?: string;
  creator?: string;
  source?: string;
  license?: string;
  language?: string;
  ownwork?: boolean;
  // Per-file variants: `${field}-${filename}`
  [key: `${string}-${string}`]: string | boolean | undefined;
}
```

---

## Priority: API/Search Results

### `routes/api.ts`

| Line | Code | Notes |
|------|------|-------|
| 103 | `(results as Record<string, any>).suggest` | ElasticSearch response |

**Potential:** Create `ElasticSearchSuggestResponse` interface based on actual response shape.

---

## Shared Types to Create

### FormFieldDefinition

```typescript
interface FormFieldDefinition {
  name: string;
  required?: boolean;
  skipValue?: boolean;
  key?: string;
  htmlKey?: string;
  type?: 'text' | 'markdown' | 'number' | 'boolean' | 'url' | 'uuid';
  flat?: boolean;
}
```

Currently duplicated in `forms.ts` as `FormField` (line 14-23).

---

## Notes

- Models using `defineModel()` are already properly typed via manifest inference
- The `as any` casts were likely added before the typed model system existed
- Index signatures `[key: string]: any` defeat TypeScript's type checking entirely
- Prefer `Record<string, unknown>` over `Record<string, any>` when exact shape unknown
