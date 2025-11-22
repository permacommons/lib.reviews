# Record<string, any> Migration Notes

Tracking the migration of loose `Record<string, any>` types to specific interfaces
in route handlers and providers.

## Priority: Model Casts in Providers

### `routes/handlers/review-provider.ts`

**Current Issues:**

| Line | Code | Issue |
|------|------|-------|
| 23 | `const ReviewModel = Review as any;` | Unnecessary - Review is already typed |
| 25 | `const UserModel = User as any;` | Unnecessary - User is already typed |
| 26 | `const FileModel = File as any;` | Unnecessary - File is already typed |
| 28-36 | Local `ThingInstance` type | Duplicates `models/manifests/thing.ts` |
| 54-69 | Local `ReviewInstance` type | Duplicates `models/manifests/review.ts` |
| 51 | `[key: string]: any;` in ReviewFormValues | Makes entire type loose |
| 74 | `static formDefs: Record<string, any>` | Could use FormFieldDefinition[] |

**Available Typed Exports:**

- `ReviewModel`, `ReviewInstance` from `models/manifests/review.ts`
- `UserModel`, `UserInstance`, `UserView` from `models/manifests/user.ts`
- `FileModel`, `FileInstance` from `models/manifests/file.ts`
- `ThingInstance` from `models/manifests/thing.ts`
- `TeamInstance` from `models/manifests/team.ts`

**Migration Plan:**

1. [x] Remove `as any` casts - use models directly (already typed)
   - Models are already typed at export (`as ReviewModel`, etc.) - just use them directly
   - No need for intermediate aliases - `Review`, `User`, `File`, `Team` work as-is
   - Added explicit casts at type boundaries (e.g., `as unknown as ReviewInstance`)
   - This reveals where local types diverge from manifest types
2. [ ] Import `ThingInstance` from manifest instead of local definition
3. [ ] Import `ReviewInstance` from manifest, remove local definition
4. [ ] Tighten `ReviewFormValues` - remove index signature, add explicit optional fields
5. [ ] Consider shared `FormFieldDefinition` type for formDefs

---

### `routes/handlers/team-provider.ts`

**Current Issues:**

| Line | Code | Issue |
|------|------|-------|
| 24 | `const _TeamJoinRequestModel = TeamJoinRequest as any;` | Needs typed model |
| 25 | `const BlogPostModel = BlogPost as any;` | Needs typed model |
| 37-45 | Local `TeamInstance` with `Record<string, any>` | Loose typing for members/moderators/etc |
| 46 | `type TeamFormValues = Record<string, any>;` | Completely untyped |
| 49 | `static formDefs: Record<string, any>` | Could use FormFieldDefinition[] |
| 558, 561 | `this.req.user as Record<string, any>` | Should use UserInstance |

---

### `routes/handlers/user-handlers.ts`

| Line | Code | Issue |
|------|------|-------|
| 11 | `const UserModel = User as any;` | Unnecessary |
| 12 | `const ReviewModel = Review as any;` | Unnecessary |
| 35 | `const bioObj: Record<string, any>` | Could be typed bio object |
| 54 | `(metaRev.bio as Record<string, any>)` | Could use UserMetaInstance typing |

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
