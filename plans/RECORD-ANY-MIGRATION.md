# Record<string, any> Migration Notes

Tracking the migration of loose `Record<string, any>` types to specific interfaces
in route handlers and providers.

## ✅ Migration Complete

All tracked `Record<string, any>` instances have been migrated to proper types:
- ✅ Form helpers (`routes/helpers/forms.ts`) - migrated to `Record<string, unknown>`
- ✅ Upload handler (`routes/handlers/api-upload-handler.ts`) - created `UploadMetadata` type
- ✅ API search results (`routes/api.ts`) - created `SuggestThingResponse` type

---

## Priority: Model Casts in Providers

### `routes/handlers/review-provider.ts`

**Current Issues:**

✅ All `Record<string, any>` issues resolved for review-provider.ts

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

**Resolution:** Used union type `teams?: string[] | TeamInstance[]` to explicitly
represent the before/after mutation state. Removed index signature and added all
fields explicitly. This provides type safety while acknowledging the mutation pattern.

**Migration Plan:**

1. [x] Remove `as any` casts - use models directly (already typed)
   - Models are already typed at export (`as ReviewModel`, etc.) - just use them directly
   - No need for intermediate aliases - `Review`, `User`, `File`, `Team` work as-is
   - Added explicit casts at type boundaries (e.g., `as unknown as ReviewInstance`)
   - This reveals where local types diverge from manifest types

2. [x] Import `ThingInstance` from manifest instead of local definition
   - [x] Add import: `import type { ThingInstance } from '../../models/manifests/thing.ts'`
   - [x] Remove local `ThingInstance` type
   - [x] No type mismatches - clean swap

3. [x] Tighten `ReviewFormValues` type
   - [x] Remove `[key: string]: any` index signature
   - [x] Add explicit fields for all form data: `url`, `label`, `originalLanguage`
   - [x] Add template helper fields: `hasRating`, `hasTeam`, `hasSocialImageID`
   - [x] Keep union type `teams?: string[] | TeamInstance[]` to represent mutation
   - Typechecks pass with no changes to call sites

4. [x] Import `ReviewInstance` from manifest
   - [x] Import as `ManifestReviewInstance`, alias to local `ReviewInstance`
   - [x] Remove 14-line local type definition
   - [x] Add `as TeamInstance[]` cast after `resolveTeamData()` (teams resolved)
   - [x] Add `as ReviewInstance` cast for `newRevision()` return (DAL type gap)

5. [x] Type `formDefs` properly
   - [x] Export `FormField` type from `routes/helpers/forms.ts`
   - [x] Change `static formDefs: Record<string, any>` to `Record<string, FormField[]>`
   - [x] Applied to all three providers (review, team, blog-post)

---

### `routes/handlers/team-provider.ts`

**Current Issues:** ✅ All `Record<string, any>` removed

**Migration Completed:**
- [x] Tightened local `TeamInstance` to manifest type; removed `Record<any>` fallbacks
- [x] Typed `TeamFormValues` explicitly
- [x] Replaced `req.user as Record<string, any>` with `RequestUser`
- [x] Left `formDefs` typed as `Record<string, FormField[]>` (already done)

---

### `routes/handlers/user-handlers.ts`

✅ All `Record<string, any>` issues resolved for user-handlers.ts

**Migration Completed:**

1. [x] Remove `as any` casts - models imported directly
2. [x] Type bioObj inline (now properly typed)
3. [x] Type metaRev.bio properly - imported `MultilingualRichText` from DAL, cast to
   `MultilingualRichText | undefined`, then construct `Required<MultilingualRichText>`

---

## Priority: Form/Request Body Types

### `routes/helpers/forms.ts`

✅ **Migration Completed:**
- [x] Changed `formValues: Record<string, any>` to `Record<string, unknown>` (lines 49, 87)
- [x] Type checker passes with no errors
- Existing transform functions and type assertions at call sites work correctly
- `unknown` is safer than `any` - forces type narrowing at usage sites

**Rationale:** Form values are dynamically built based on formDef. Rather than attempting complex generic inference, we use `Record<string, unknown>` which:
- Requires explicit type narrowing at call sites (safer than `any`)
- Acknowledges dynamic nature of form parsing
- Works with existing `transform` function pattern in `parseData<TParsed>()`

### `routes/handlers/api-upload-handler.ts`

✅ **Migration Completed:**
- [x] Created `UploadMetadata` type with proper structure
- [x] Updated `UploadRequest` type to use `UploadMetadata` instead of `Record<string, any>`
- [x] Updated all function signatures: `validateAllMetadata`, `validateMetadata`, `addMetadata`, `addMetadataToFileRev`
- [x] Changed `checkRequired` to use `Record<string, unknown>` (generic utility)
- [x] Updated `addMlStr` inner function to accept `FileInstance` directly
- [x] Type checker passes with no errors

**Created Type:**
```typescript
type UploadMetadata = {
  multiple?: boolean;
  // Single file metadata (no suffix)
  description?: string;
  creator?: string;
  source?: string;
  license?: string;
  language?: string;
  ownwork?: boolean;
  // Multiple file metadata (with `-${filename}` suffix)
  [key: `description-${string}`]: string | undefined;
  [key: `creator-${string}`]: string | undefined;
  [key: `source-${string}`]: string | undefined;
  [key: `license-${string}`]: string | undefined;
  [key: `language-${string}`]: string | undefined;
  [key: `ownwork-${string}`]: boolean | undefined;
};
```

---

## Priority: API/Search Results

### `routes/api.ts`

✅ **Migration Completed:**
- [x] Created `SuggestThingResponse` type for ElasticSearch suggest queries
- [x] Moved type definition to `search.ts` and exported it
- [x] Updated return type from `Promise<SearchResponse<any>>` to `Promise<SuggestThingResponse>`
- [x] Updated `routes/api.ts` to import and use typed response directly (no casting needed at call site)
- [x] Updated test mock in `tests/helpers/mock-search.ts` to return correct type
- [x] Type checker passes with no errors

**Solution:** Created `SuggestThingResponse` type and updated the function signature in `search.ts`. The function uses `.search()` with a suggest body (correct for ES 6.0+, as the `_suggest` endpoint was removed). A single `as unknown` cast is needed in `search.ts` because the client library's `SearchResponse` type doesn't match the actual suggest response structure.

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
