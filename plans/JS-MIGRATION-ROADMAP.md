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

#### Wave 4 — routers & handlers
- [ ] Convert domain routers together with their handler stacks so each feature ships fully typed:
  - [ ] Accounts & authentication: `routes/actions.js`, `routes/users.js`, `routes/handlers/action-handler.js`, `routes/handlers/user-handlers.js`, `routes/handlers/signin-required-route.js`.
  - [ ] Team management: `routes/teams.js`, `routes/handlers/team-provider.js`, `routes/handlers/resource-error-handler.js`.
  - [ ] Things & reviews: `routes/things.js`, `routes/reviews.js`, `routes/handlers/abstract-bread-provider.js`, `routes/handlers/review-provider.js`, `routes/handlers/review-handlers.js`, `routes/helpers/slugs.js`.
  - [ ] Files & uploads: `routes/files.js`, `routes/uploads.js`, `routes/handlers/api-upload-handler.js`, `routes/helpers/feeds.js`, `routes/helpers/forms.js`.
  - [ ] Content & API: `routes/blog-posts.js`, `routes/pages.js`, `routes/api.js`, `routes/helpers/render.js`, `routes/helpers/api.js`, `routes/helpers/flash.js`.
- [ ] Migrate any lingering middleware modules discovered during the router conversions and wire them up to the shared `types/http` contracts.
- [ ] Remove `models/*.js` compatibility re-exports once all HTTP code imports the `.ts` implementations directly.

#### Wave 5 — frontend
- [ ] Convert browser entrypoints (`frontend/libreviews.js`, `frontend/review.js`, `frontend/upload.js`, `frontend/upload-modal.js`, `frontend/user.js`, `frontend/manage-urls.js`) to `.ts` while preserving lazy-load boundaries.
- [ ] Port the editor stack (`frontend/editor-*.js`, `frontend/adapters/*`) to TypeScript with shared module augmentations for ProseMirror and jQuery plugins under `types/frontend/`.
- [ ] Tighten message and localization helpers by typing `frontend/messages/*.json`, `frontend/editor-messages.js`, and `frontend/upload-modal-messages.js`.
- [ ] Update Vite configuration and build scripts to emit declaration files for shared frontend utilities consumed by the backend (e.g., `frontend/register.ts`).

#### Wave 6 — tests, tooling & strictness
- [ ] Rename AVA specs (`tests/*.js`) and helpers to `.ts`, converting `tests/run-ava.js`, fixture builders, and HTTP helpers to ESM TypeScript.
- [ ] Type the Node-facing scripts in `bin/` and `tools/` so `bin/www.js` and maintenance utilities compile under `tsconfig.node.json`.
- [ ] Add TypeDoc coverage checks for the migrated util and DAL modules to ensure comments stay aligned with runtime behaviour.
- [ ] Expand automation: update AVA configuration to load `.ts` files, run `tsc --project tsconfig.tests.json --noEmit` in CI, and add `npm run typecheck:tests` to the default workflow.
- [ ] Turn on `noImplicitAny`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` sequentially, addressing fallout before moving to the next flag.
- [ ] Introduce a Biome (or eslint-tsdoc) equivalent rule to enforce documentation on exported symbols and remove remaining `@ts-ignore` directives in favour of refined types.
- [ ] Enable `strict: true` once the outstanding TypeScript error count drops below 50 and all new checks are green.

### Exit criteria for Phase 2
- [ ] All source files under `models/`, `dal/`, `routes/`, `frontend/`, and `util/` compiled as TypeScript.
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
