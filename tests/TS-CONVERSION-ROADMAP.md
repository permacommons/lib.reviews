# Test Suite Type Adoption Plan

Progressively tighten the AVA test harness so the mocks and fixtures align with
the typed runtime. Each wave should leave the suite runnable under
`tsconfig.tests.json` (casting only where the production API genuinely accepts
dynamic data).

## 📊 Current Status
- **Tests passing:** ✅ All 174 tests pass
- **TypeScript errors:** 0 (Zero errors! 🎉)
- **Completion:** Wave 1, Wave 2, Wave 2.1, Wave 3, and Wave 4 complete
- **Next priority:** Wave 5 & 6 (Query builder, DAL unit tests, search mocks) — targeted cleanup for remaining `as any` casts

### Key Learnings
- Use `tests/types/` for test-specific shared types (mocks, helpers), not type wheels
- Use `typeof import('../models/thing.ts').default` pattern for model typing in tests
- Consistent type annotations across models (Thing, User, Team, Review, File) enable full type checking
- Adding explicit model type exports helps TypeScript understand model structure without requiring `strict` mode in production

## Wave 1 — Fixture scaffolding
- [x] Retrofit `DALFixtureAVA` with typed accessors for core models (`Thing`,
  `Review`, `User`, etc.), replacing the current `[key: string]: any` escapes.
- [x] Give `setupPostgresTest` a typed return signature that exposes those
  accessors and marks optional helpers (`cleanupTables`, `initializeModels`)
  with precise shapes.
- [x] Update helpers like `ensureUserExists`, `createTestUser`, and
  `mockSearch` to return typed structures instead of `{}` fallbacks.

> Notes (Wave 1): Remaining suites still depend on loosely typed Express and supertest
> mocks (see `tests/24-integration-signed-out.ts`, `tests/33-csrf-protection.ts`,
> `tests/28-flash-store.ts`). Next pass should add lightweight typed wrappers for
> those request/response objects so we can drop the lingering `any` casts when
> calling middleware.

## Wave 2 — Adapter & Express mocks ✅
- [x] Replace handwritten adapter stubs with objects that satisfy
  `AdapterLookupResult` (populate `label`, `description`, and `subtitle`
  appropriately).
- [x] Introduce minimal typed wrappers for the Express `Request`/`Response`
  mocks used in slug and upload tests so the helpers can accept real request
  shapes without `as any` casts.
- [x] Plumb the typed Express helpers into integration fixtures so the shared
  `app`/`agent` context is fully typed (see `tests/24-integration-signed-out.ts`
  and `tests/33-csrf-protection.ts`).
- [x] Capture shared testing types for our mock responses (e.g., search hits,
  autocomplete payloads) under `tests/types/` to avoid re-declaring them.
- [x] Type DAL model helpers used in search suites (`createFirstRevision`,
  `filterNotStaleOrDeleted`, etc.) so search-index tests stop leaning on `unknown`.

> **Completed Notes (Wave 2):**
> - Created `tests/types/integration.ts` for shared integration test types
> - Updated `tests/fixtures/dal-fixture-ava.ts` to use actual model types via `typeof import()` pattern
> - All adapter mocks now use `AdapterLookupResult` type
> - Added explicit type annotations in search tests

### Wave 2.1 — Integration helpers (completed alongside Wave 2) ✅
- [x] Type the return values of helpers such as `registerTestUser`,
  `extractCSRF`, and the session bootstrap utilities so callers lose their
  `unknown` handling.
- [x] Formalize the `app`/`agent` structures returned by integration fixtures
  (supertest's `SuperAgentTest` plus Express `Application`).

## Wave 3 — Model source typing ✅
- [x] Add explicit type annotations to `models/review.ts` similar to those in `models/thing.ts`
  - The Review model proxy needs `ThingModel`-style typing so `createFirstRevision()` and `filterNotStaleOrDeleted()` aren't seen as `{}`
  - See `models/thing.ts:8-24` for the pattern: `type ThingInstance`, `type ThingModel`, etc.
- [x] Verify other model files (User, Team, File, etc.) have consistent type exports
- [x] Re-run `npx tsc --noEmit -p tsconfig.tests.json` to confirm the 6 remaining errors are resolved

> **Completed Notes (Wave 3):**
> - Added explicit type annotations to `models/review.ts` following the Thing model pattern
> - Updated `models/file.ts` with consistent PostgresModule typing
> - Fixed type assignment issue in `tests/helpers/mock-search.ts` unmockSearch function
> - Result: Zero TypeScript errors in test suite! All models now have consistent type exports.

## Wave 4 — Supertest & integration audit ✅
- [x] Audit supertest usage to ensure chained calls respect async typing and
  headers (`.set`, `.expect`) carry correct types.
- [x] Review all integration test files for any remaining `any` casts or untyped contexts.

> **Completed Notes (Wave 4):**
> - All integration tests (24, 25, 32, 33, 34) have proper supertest typing
> - All async supertest calls are properly awaited
> - Response headers accessed with correct typing (e.g., `response.headers.location`)
> - No `as any` casts found in any integration test files
> - `IntegrationTestContext` provides proper types for app and agent
> - Work completed in Waves 1-3 already ensured integration tests were well-typed

## Wave 5 — Query builder & DAL unit tests
- [ ] Swap ad-hoc mock models for light-weight `Model` subclasses that satisfy
  the `ModelConstructor` interface (or export a dedicated `createMockModel`
  utility that provides the needed prototype).
- [ ] Replace the file-level `// @ts-nocheck` with targeted helper functions and
  explicit casts where the test intentionally violates the model API.
- [ ] Document any remaining deliberate `any` usage (e.g., when simulating bad
  inputs) so future cleanups know where the escape hatches are.

## Wave 6 — Search mocks & dynamic imports
- [ ] Harmonize search mocks with the real Elastic client return types
  (`SearchResponse<T>`), including pagination metadata.
- [ ] Provide typed wrappers for sync scripts (mocking DAL methods and adapters)
  so they can compile without runtime imports.
- [ ] Ensure deferred imports inside tests (dynamic `await import(...)`) have
  typed re-exports in place, or switch to upfront imports once the modules are
  fully typed.

## Wave 7 — Final tightening
- [ ] Remove legacy `as any` escapes after the preceding waves land; re-run
  `tsc --noEmit -p tsconfig.tests.json` to verify zero errors.
- [ ] Enable stricter compiler flags for the test project (`noImplicitAny`,
  `exactOptionalPropertyTypes`) and resolve remaining issues.
- [ ] Update contributor docs (`tests/README.md`) to reflect the new testing
  conventions, highlighting how to add typed fixtures and mocks.
