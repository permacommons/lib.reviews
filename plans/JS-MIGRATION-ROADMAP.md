# Migration Roadmap: ESM → TypeScript → Biome

This document tracks the three-phase migration of lib.reviews to modern tooling.

## Current State Snapshot (2025-10-30)

- 109 `.js` files remain in CommonJS across the repository (runtime + tooling; excludes `.mjs` tests and generated `build/` artifacts).
- Backend entry points: `bin/www.mjs` and `app.mjs` now run as ESM and share the ESM-native `bootstrap/dal.mjs`; the legacy `bootstrap/dal.js` entry has been removed so stale `require` calls fail fast.
- Directory breakdown: adapters (7), dal (12), models (11), routes (28 incl. helpers), util (15), maintenance (5), frontend legacy (25), single-file modules (`auth.js`, `db-postgres.mjs`, `search.js`, `tools/*.js`, `locales/languages.js`).
- `createRequire(import.meta.url)` still appears in `app.mjs` plus 21 test helpers/specs to reach CommonJS modules; these call sites should switch to direct ESM imports as their dependencies expose compatible entry points.
- TypeScript-ready surface already exists for tests (`tests/*.mjs`) and Vite (`vite.config.mjs`), easing eventual `allowJs` adoption.
- Next focus: start lifting the adapters directory to ESM; `adapters/adapters.js` still `require`s the error helpers and will need fresh imports once languages/model layers move.

## Phase 1: ESM Migration

Convert the entire codebase from CommonJS to ESM modules.

### Preparation
- [ ] Add `"type": "module"` to package.json
- [ ] Audit dependencies for ESM compatibility
- [ ] Create ESM migration testing strategy
- [ ] Set up feature branch for ESM migration

### Backend Core (74 CommonJS files)
- [x] Convert `/bin/www` entry point
- [x] Convert `/app` main application file
- [x] Convert `/bootstrap/*.js` initialization files
- Current status: `bootstrap/dal.mjs` now provides the shared bootstrap; no CommonJS files remain in this directory.
- Direct consumers of `bootstrap/dal.mjs` to watch during migration:
  - `app.mjs` (ESM): imports `initializeDAL()` directly.
  - Tests: `setupPostgresTest.mjs` and DAL fixtures rely on the exported test harness helpers.
  - `db-postgres.mjs`: reuses/exports DAL helpers for other parts of the app.
  - Maintenance scripts (`maintenance/*.js`) and sync adapters (`adapters/sync/*.js`) import it lazily from CommonJS.
  - DAL internals (`dal/lib/model-handle.js`) rely on `setBootstrapResolver` for handle wiring.
- Migration guardrails:
  - Preserve singleton semantics for DAL initialization; confirm `initializeDAL` continues to de-duplicate concurrent callers after conversion.
  - Evaluate exposing explicit ESM exports for model bootstrap so tests can tree-shake unwanted work.
  - Ensure CommonJS consumers retain compatibility during incremental rollout—consider adding a thin compatibility shim if needed.

#### `bootstrap/dal` conversion staging (completed)
- [x] Ship `bootstrap/dal.mjs` that re-exports the existing CommonJS API, giving ESM modules a forward-compatible import path.
- [x] Update `app.mjs` to consume the `.mjs` entry and drop its `createRequire` bridge.
- [x] Update AVA helpers/tests currently using `createRequire(import.meta.url)` to import from `bootstrap/dal.mjs`.
- [x] Convert runtime CommonJS consumers (maintenance scripts, sync adapters) so they can import the `.mjs` entry without shims.
- [x] Untangle `dal/lib/model-handle.js` from `require('../../bootstrap/dal')` (or migrate the DAL library to ESM) before flipping the implementation.
- [x] After dependents are ESM-ready, move the implementation to ESM and remove the `.cjs` entry so stale `require` paths fail fast.
- [ ] Re-run DAL bootstrap/search integration tests after each stage to ensure singleton semantics and migrations remain stable.

### Models Layer (~140 KB)
- [x] Convert `/models/invite-link.js`
- [x] Convert `/models/team-join-request.js`
- [x] Convert `/models/team-slug.js`
- [ ] Convert `/models/thing.js`
- [ ] Convert `/models/review.js`
- [ ] Convert `/models/user.js`
- [ ] Convert `/models/team.js`
- [ ] Convert all remaining model files

### DAL Layer (~188 KB)
- [ ] Convert `/dal/*.js` data access layer
- [ ] Update database connection handling
- [ ] Verify revision system compatibility

### Routes Layer (~236 KB)
- [x] Convert `/routes/actions.js` route handler
- [x] Convert `/routes/reviews.js` route handler
- [x] Convert `/routes/teams.js` route handler (+ `handlers/team-provider.js`)
- [x] Convert `/routes/users.js` route handler
- [x] Convert `/routes/things.js` route handler
- [x] Convert `/routes/api.js` route handler
- [x] Convert `/routes/files.js` route handler
- [x] Convert `/routes/pages.js` route handler
- [x] Convert `/routes/blog-posts.js` route handler
- [x] Convert `/routes/uploads.js` route handler
- [x] Convert remaining `/routes/*.js` route handlers
- [ ] Update Express route registrations

### Utilities & Helpers
- [ ] Convert `/util/*.js` utility functions
  - [x] `client-assets`
  - [x] `debug`
  - [x] `flash-store`
  - [x] `frontend-messages`
  - [x] `get-messages`
  - [x] `abstract-generic-error`
  - [x] `abstract-reported-error`
  - [x] `reported-error`
  - [x] `handlebars-helpers`
  - [x] `md`
  - [x] `url-utils`
  - [x] `webhooks`
- [x] Convert route helpers
  - [x] `/routes/helpers/api`
  - [x] `/routes/helpers/flash`
  - [x] `/routes/helpers/render`
  - [x] `/routes/helpers/feeds`
  - [x] `/routes/helpers/forms`
  - [x] `/routes/helpers/slugs`
- [ ] Convert `/adapters/*.js` (OpenLibrary, Wikidata, OSM)

### Configuration & Infrastructure
- [ ] Update `config/` files for ESM
- [x] Convert `db-postgres` database layer
- [ ] Update any module proxy patterns (module-handle.js)

### Testing
- [ ] Verify all tests still pass (tests already ESM)
- [ ] Update test fixtures if needed
- [ ] Add integration test for ESM compatibility

### Documentation & Scripts
- [ ] Update npm scripts in package.json for ESM
- [ ] Update JSDoc configuration
- [ ] Update any build/deployment scripts
- [ ] Document breaking changes

### Validation
- [ ] All tests passing
- [ ] Dev server runs correctly
- [ ] Production build succeeds
- [ ] All routes functional
- [ ] Database operations working

---

## Phase 2: TypeScript Migration

Gradually migrate to TypeScript with type safety.

### Setup
- [ ] Install TypeScript and type definitions
- [ ] Create `tsconfig.json` with `allowJs: true`
- [ ] Configure Vite for TypeScript
- [ ] Add type definitions for major dependencies

### Type Definitions First
- [ ] Create type definitions for core models
- [ ] Create type definitions for DAL interfaces
- [ ] Create type definitions for Express middleware/routes
- [ ] Create type definitions for utility functions

### Tests Migration
- [ ] Rename `.mjs` test files to `.ts`
- [ ] Add types to test files
- [ ] Update AVA configuration for TypeScript
- [ ] Verify all tests still pass

### Frontend Migration
- [ ] Convert `/frontend/*.js` to `.ts`
- [ ] Add types for ProseMirror usage
- [ ] Add types for jQuery usage
- [ ] Type check frontend entry points

### Backend Migration (Layer by Layer)
- [ ] Convert `/models` to TypeScript
- [ ] Convert `/dal` to TypeScript (high value for types)
- [ ] Convert `/util` to TypeScript
- [ ] Convert `/routes` to TypeScript
- [ ] Convert `/adapters` to TypeScript
- [ ] Convert `/bootstrap` to TypeScript

### Core Application
- [ ] Convert `app.ts`
- [ ] Convert `bin/www.ts`
- [ ] Update database layer with types

### Type Safety Enhancement
- [ ] Enable `strict: true` in tsconfig
- [ ] Fix all type errors
- [ ] Remove `any` types where possible
- [ ] Add JSDoc comments as needed

### Testing & Validation
- [ ] All tests passing with TypeScript
- [ ] No TypeScript errors in build
- [ ] Runtime behavior unchanged
- [ ] Type coverage report generated

### Documentation
- [ ] Update README with TypeScript setup
- [ ] Document type system conventions
- [ ] Update contributor documentation

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
