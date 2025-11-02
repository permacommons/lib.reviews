# Migration Roadmap: ESM → TypeScript → Biome

This document tracks the three-phase migration of lib.reviews to modern tooling.

## Phase 1: CommonJS -> ESM migration

Completed.

## Phase 2: TypeScript Migration

Goal: fully type-check both backend and frontend without sacrificing delivery velocity. The migration should always leave the  branch buildable and green.

### Guiding principles
- Port or add meaningful descriptive code comments in Typedoc formats; do include parameters, but don't repeat _types_ there, since Typescript covers that
- Prefer renaming `.js` files to `.ts`/`.tsx` only after TypeScript errors for that module are resolved.
- Keep `allowJs` on until at least 80% of the codebase (measured by line count) is typed.
- Use `// @ts-expect-error` instead of `any` when a known issue is deferred.
- Avoid circular dependencies introduced by splitting type-only modules.

### Pre-flight inventory
- [x] Document the existing module graph (use `depcruise` or similar) and check the artifact into `plans/` for reference (see `plans/module-graph.json`).
- [x] Audit npm dependencies and record missing or outdated type packages in `plans/ts-migration-deps.md`.
- [x] Enable `skipLibCheck: false` locally to surface issues while adding new types.

### Tooling & infrastructure
- [x] Install TypeScript and type definitions
- [x] Create `tsconfig.json` with `allowJs: true`
- [x] Configure Vite for TypeScript
- [x] Add type definitions for major dependencies
- [x] Create `tsconfig.node.json` for scripts in `bin/` and `tools/`
- [x] Add `tsconfig.tests.json` that extends the main config with AVA globals

### Migration waves
Each wave should ship as a sequence of small PRs. Every box represents at most a few files (≈300 LOC) so reviews stay manageable.

#### Wave 0 — shared contracts
- [x] Publish shared ambient declarations in `types/` for configuration, DAL context, and Express locals.
- [x] Define interfaces for DAL records (`dal/*.js`) without converting implementation files yet.
- [x] Introduce enums/union types for user roles, permissions, and locales under `types/domain/`.
- [x] Add type-safe helpers for common utilities (`util/*`), starting with logging and date formatting.

#### Wave 1 — low-risk utilities
- [x] Convert the error/reporting stack under `util/` to `.ts` (`abstract-generic-error`, `abstract-reported-error`, `reported-error`, `debug`) and install missing `@types/*` packages for `sprintf-js` and `escape-html`.
- [x] Rename existing `.d.ts` shims to real TypeScript modules for shared helpers (`util/date`, `util/http`, `util/webhooks`) and delete their parallel declaration files.
- [x] Type markdown and messaging helpers (`util/md`, `util/get-messages`, `util/frontend-messages`, `util/get-license-url`), adding minimal ambient modules for plugins like `markdown-it-html5-media`.
- [x] Migrate asset/session utilities that only rely on Node built-ins or Express request typing (`util/client-assets`, `util/url-utils`, `util/flash-store`).

#### Wave 2 — data layer
- [x] Convert DAL entrypoints and primitives (`dal/index`, `dal/lib/errors`, `dal/lib/type`, `dal/lib/ml-string`, `dal/lib/revision`) to `.ts`, aligning runtime exports with `dal/index.d.ts`.
- [x] Migrate model infrastructure (`dal/lib/model`, `dal/lib/model-factory`, `dal/lib/model-registry`) to `.ts` with generics for record payloads.
- [x] Port bootstrap helpers (`dal/lib/model-initializer`, `dal/lib/model-handle`, `bootstrap/dal`) to TypeScript and ensure typed registration flows.
- [x] Type connection and query orchestration (`dal/lib/data-access-layer`, `dal/lib/query-builder`, `db-postgres`) so Postgres pooling and transactions expose concrete interfaces.
- [x] Convert the first batch of PostgreSQL models (`models/user`, `models/user-meta`, `models/team`, `models/team-join-request`, `models/team-slug`) to `.ts`, using the new DAL generics for relations.
- [x] Convert remaining models that back reviews and assets (`models/thing`, `models/thing-slug`, `models/review`, `models/blog-post`, `models/file`, `models/invite-link`).
  - [x] `models/thing`, `models/thing-slug`
- [x] Remove the temporary `.js` re-export shims for `util/` helpers once DAL
  imports compile against the native TypeScript sources.


#### Wave 3 — application bootstrap & shared middleware
- [x] Convert entrypoints that still import `.js` shims to native `.ts` modules (`app.ts`, `auth.ts`, `bootstrap/dal.ts`).
- [x] Replace remaining JavaScript utilities used at startup (`util/csrf.js`, `util/handlebars-helpers.js`) with TypeScript implementations and shared ambient types for Handlebars helpers.
- [x] Port top-level Express infrastructure (`routes/errors.js`, `routes/helpers/*`) to `.ts`, introducing `types/http/locals.ts` and request/user augmentations for shared middleware state.
- [x] Ensure session, flash, and DAL locals use the new interfaces and drop obsolete `.js` re-export files once all imports resolve to `.ts`.

#### Wave 4 — routers & request handlers
With bootstrap and shared middleware typed, finish migrating HTTP entrypoints and eliminate the remaining `.js` shims.

##### 4.1 Shared handler infrastructure
- [x] Convert common handler utilities in `routes/handlers/` to `.ts`, modelling reusable generics for `Request`, `Response`, and template context helpers (`action-handler`, `signin-required-route`, `abstract-bread-provider`, `review-provider`, `team-provider`, `resource-error-handler`, `api-upload-handler`, `review-handlers`, `user-handlers`, `blog-post-provider`).
- [x] Expand `types/http/locals.ts` and related Express augmentations so `req.locale`, `req.flash`, `req.session`, and authenticated `req.user` lifecycles reflect the behaviour relied on by handlers.
- [x] Port cross-cutting service modules consumed by routes to TypeScript: `search.js` → `search.ts` (typed ElasticSearch client), `locales/languages.js` → `languages.ts` (locale metadata unions), and any thin helper shims under `types/http/handlebars.d.ts` that can now become concrete modules.
- [x] Convert backend metadata adapters under `adapters/` to `.ts`, leveraging existing typed utilities and locale metadata:
  - [x] Define a typed abstract adapter contract and shared result shape: [`adapters/abstract-backend-adapter.ts`](adapters/abstract-backend-adapter.ts) with `AdapterLookupData`, `AdapterLookupResult`, and methods `ask()`, `lookup()`, `getSupportedFields()`, `getSourceID()`, `getSourceURL()`.
  - [x] Create a typed adapter registry: [`adapters/adapters.ts`](adapters/adapters.ts) exposing `getAll()`, `getAdapterForSource()`, `getSourceURL()`, `getSupportedLookupsAsSafePromises()`.
  - [x] Port adapter implementations: [`adapters/wikidata-backend-adapter.ts`](adapters/wikidata-backend-adapter.ts), [`adapters/openlibrary-backend-adapter.ts`](adapters/openlibrary-backend-adapter.ts), [`adapters/openstreetmap-backend-adapter.ts`](adapters/openstreetmap-backend-adapter.ts), reusing [`util/http.ts`](util/http.ts) and [`locales/languages.ts`](locales/languages.ts).
  - [x] Update consumers to use the typed registry and public adapter methods (e.g., [`models/thing.ts`](models/thing.ts), maintenance scripts).
  - [x] Introduce temporary `.js` re-export shims under `adapters/` to preserve legacy imports; delete them in 4.3 once all consumers target `.ts`.

##### 4.2 Domain routers
- [x] Accounts & authentication: convert `routes/actions.js` and `routes/users.js` to `.ts`, ensuring Passport callbacks, invite-link flows, and flash messaging use the shared HTTP types introduced in Wave 4.1.
- [x] Team management: convert `routes/teams.js` to `.ts`, wiring the typed `team-provider` and `resource-error-handler` helpers from Wave 4.1 into the route context.
- [x] Things & reviews: convert `routes/things.js` and `routes/reviews.js` to `.ts`, consuming the existing TypeScript providers (`abstract-bread-provider`, `review-provider`, `review-handlers`) and typed slug/pagination helpers.
- [x] Files & uploads: convert `routes/files.js` and `routes/uploads.js` to `.ts`, relying on the typed upload handler, feed/form helpers, and asset utilities added earlier in the wave.
- [x] Content & API: convert `routes/blog-posts.js`, `routes/pages.js`, and `routes/api.js` to `.ts`, tightening types for rendered view models and API payloads.
- [x] Verify backend type-check and integration test suites succeed after the router conversions.

##### 4.3 Compatibility cleanup
- [x] Remove the `.js` compatibility facades in `models/` and `dal/lib/` once all route handlers import the native `.ts` modules.
- [x] Delete any obsolete `.d.ts` shims or barrel files that only existed to bridge `.js` consumers.

#### Wave 5 — frontend
Target the browser bundles next, starting with the shared infrastructure and ending with feature-specific code.

##### 5.1 Tooling and type foundations
- [x] Extend `tsconfig.frontend.json` (or add a dedicated config) with DOM lib targets and module resolution for static assets so the browser build compiles under TypeScript.
- [x] Introduce `types/frontend/` module augmentations for jQuery, ProseMirror plugins, Dropzone, and any bespoke globals relied on by the editor stack.
- [x] Update Vite and `package.json` scripts to emit `.d.ts` artifacts for shared code (`frontend/register.ts`) consumed by server-rendered templates.

##### 5.2 Core entrypoints & messaging
- [x] Convert runtime entrypoints to `.ts`, keeping dynamic imports split the same way as today.
  - [x] `frontend/libreviews.ts` (was `frontend/libreviews.js`)
  - [x] `frontend/review.ts` (was `frontend/review.js`)
  - [x] `frontend/upload.ts` (was `frontend/upload.js`)
  - [x] `frontend/upload-modal.ts` (was `frontend/upload-modal.js`)
  - [x] `frontend/user.ts` (was `frontend/user.js`)
  - [x] `frontend/manage-urls.ts` (was `frontend/manage-urls.js`)
- [x] Type the localization/message helpers by transforming `frontend/editor-messages.js`, `frontend/upload-modal-messages.js`, and `frontend/messages/*.json` into typed modules (or generated `.ts` exports) that feed the new entrypoints.
- [x] Ensure the flash messaging and modal bootstrapping utilities share interfaces with the server-rendered context objects defined in Wave 4.

##### 5.3 Editor & adapter ecosystem
- [x] Port the editor core (`frontend/editor.js`, `frontend/editor-menu.js`, `frontend/editor-prompt.js`, `frontend/editor-extended-keymap.js`, `frontend/editor-inputrules.js`, `frontend/editor-selection.js`, `frontend/editor-markdown.js`) to `.ts`, leaning on the new ProseMirror typings and centralising schema types.
- [x] Convert adapter modules under `frontend/adapters/` to TypeScript, introducing discriminated unions for lookup results (Wikidata, OpenStreetMap, OpenLibrary, native) and extracting shared message shapes into `types/frontend/adapters.ts`.
- [x] Migrate ancillary helpers such as drag-and-drop/upload wiring to typed modules and delete any `.d.ts` stopgaps left in `types/`.

#### Wave 6 — tests, tooling & strictness
Finalize the migration by bringing tests, scripts, and compiler settings in line with the fully typed runtime.

- [ ] Port AVA to TypeScript: rename `tests/*.js` to `.ts`, update fixtures and helpers, and convert `tests/run-ava.js` into a typed runner that compiles under `tsconfig.tests.json`.
- [ ] Type the supporting Node scripts in `bin/` and `tools/` (including `bin/www.js`, maintenance scripts, and DB utilities) using `tsconfig.node.json`, replacing any ad-hoc `.d.ts` declarations with concrete modules and standardizing execution through `tsx`.
- [ ] Convert backend adapter sync scripts to TypeScript and type their orchestration against DAL and search services: [`adapters/sync/sync-all.js`](adapters/sync/sync-all.js), [`adapters/sync/sync-wikidata.js`](adapters/sync/sync-wikidata.js). Update adapter test mocks and dynamic imports accordingly, consuming the typed registry [`adapters/adapters.ts`](adapters/adapters.ts).
- [ ] Add documentation/Typedoc coverage checks for the migrated util, DAL, and route modules to guarantee API comments stay synced with implementations.
- [ ] Expand automation: configure AVA to load `.ts` files, run `tsc --noEmit` with the test project in CI, and wire `npm run typecheck:tests` into the default workflow.
- [ ] Ratchet TypeScript compiler options sequentially (`noImplicitAny`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, then `strict: true`), resolving surfaced issues before enabling the next flag.
- [ ] Replace any lingering `@ts-ignore` directives with more precise types or `@ts-expect-error` (where the failure is intentional) and mirror the lint enforcement during the subsequent Biome migration.

### Exit criteria for Phase 2
- [x] All source files under `models/`, `dal/`, `routes/`, `frontend/`, `util/`, and `adapters/` compiled as TypeScript, with typed adapter registry [`adapters/adapters.ts`](adapters/adapters.ts) and no `.js` shims under `adapters/`.
- [ ] `tsc --noEmit` passes in CI for application code and tests.
- [ ] Type coverage report (`ts-prune` or `type-coverage`) shows ≥90% typed declarations.
- [ ] Documentation updated (`README`, `CONTRIBUTING`) with TypeScript setup instructions.
- [ ] Typedoc includes backend and frontend entry points without warnings.

---

## Phase 3: Biome Migration

Replace ESLint with Biome for linting and formatting.

### Setup
- [ ] Install Biome (`@biomejs/biome`)
- [ ] Initialize `biome.json` configuration
- [ ] Migrate ESLint rules to Biome configuration
- [ ] Configure Biome for TypeScript

### Rule Migration
- [ ] Review existing `.eslintrc.json` rules (150+)
- [ ] Map ESLint rules to Biome equivalents
- [ ] Configure formatting rules (replacing code style ESLint rules)
- [ ] Set up import sorting

### Integration
- [ ] Add Biome npm scripts (`biome check`, `biome format`)
- [ ] Update VSCode/editor settings for Biome
- [ ] Configure pre-commit hooks if needed
- [ ] Update CI/CD to use Biome

### Cleanup
- [ ] Remove ESLint dependencies
- [ ] Remove `.eslintrc.json`
- [ ] Remove `.jshintrc` (legacy)
- [ ] Clean up package.json scripts

### Validation
- [ ] Run Biome check on entire codebase
- [ ] Fix any new issues found
- [ ] Verify formatting is consistent
- [ ] Run full test suite

### Documentation
- [ ] Update contributor guidelines for Biome
- [ ] Document Biome commands
- [ ] Update editor setup instructions

---

## Post-Migration

### Final Validation
- [ ] Full test suite passes
- [ ] Production build succeeds
- [ ] Local dev server works
- [ ] All API endpoints functional
- [ ] Database migrations compatible
- [ ] Documentation up to date

### Deployment
- [ ] Update deployment scripts for ESM/TS
- [ ] Update Node.js version if needed
- [ ] Deploy to staging environment
- [ ] Smoke test in staging
- [ ] Deploy to production

### Monitoring
- [ ] Monitor for runtime errors
- [ ] Check performance metrics
- [ ] Verify no regressions
- [ ] Collect team feedback

---

## Notes

- Each phase should be completed and validated before moving to the next
- Consider doing Phase 1 and 2 in smaller increments (per-directory)
- Create feature branches for each major phase
- Run tests frequently during migration
- Document any blockers or issues encountered
