# Migration Roadmap: ESM → TypeScript → Biome

This document tracks the three-phase migration of lib.reviews to modern tooling.

## Current State Snapshot (2025-10-30)

- 111 `.js` files remain in CommonJS across the repository (includes backend and tooling; excludes `.mjs` tests).
- Backend entry points: `bin/www.mjs` now runs as ESM while bridging into CommonJS `app.js` and `bootstrap/dal.js`, which remain to be migrated.
- Directory breakdown: adapters (7), dal (12), models (11), routes (28 incl. helpers), util (14), maintenance (5), build scripts (2), frontend legacy (25), single-file modules (`auth.js`, `db-postgres.js`, `search.js`, `tools/*.js`, `locales/languages.js`).
- TypeScript-ready surface already exists for tests (`tests/*.mjs`) and Vite (`vite.config.mjs`), easing eventual `allowJs` adoption.
- Next focus: convert `app.js` (Express bootstrap) without breaking the remaining CommonJS modules it pulls in—evaluate side-effect imports (`./auth`, `./util/handlebars-helpers.js`) carefully.

## Phase 1: ESM Migration

Convert the entire codebase from CommonJS to ESM modules.

### Preparation
- [ ] Add `"type": "module"` to package.json
- [ ] Audit dependencies for ESM compatibility
- [ ] Create ESM migration testing strategy
- [ ] Set up feature branch for ESM migration

### Backend Core (74 CommonJS files)
- [x] Convert `/bin/www` entry point
- [ ] Convert `/app.js` main application file
- [ ] Convert `/bootstrap/*.js` initialization files
- Current inventory (2025-10-30):
  - `app.js`
  - `bootstrap/dal.js`
- Direct `require` targets inside `app.js` that must keep working when it moves to ESM:
  - External: express, path, fs, serve-favicon, serve-index, morgan, cookie-parser, body-parser, i18n, hbs, hbs-utils, express-session, connect-pg-simple, express-useragent, passport, csurf, config, compression, helmet-csp.
  - Internal: `./util/webhooks`, `./locales/languages`, `./routes/helpers/api`, `./routes/helpers/flash`, `./routes/errors`, `./util/debug`, `./util/client-assets`, `./util/flash-store`, `./util/handlebars-helpers.js`, `./bootstrap/dal`, `./auth`, `./routes/*`, `./routes/uploads`.
- Migration guardrails:
  - Prefer `import pkg from 'pkg'` + `.default` shims only when required (most dependencies expose CommonJS defaults that map cleanly).
  - Use `createRequire` for modules that export configured functions (`hbs-utils`, `connect-pg-simple`) until their ESM equivalents are confirmed.
  - Keep `require`-driven side effects (`./auth`, `./util/handlebars-helpers.js`) via dynamic `await import()` to avoid reordering initialization.

### Models Layer (~140 KB)
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
- [ ] Convert `/routes/*.js` route handlers
- [ ] Update Express route registrations

### Utilities & Helpers
- [ ] Convert `/util/*.js` utility functions
- [ ] Convert route helpers
- [ ] Convert `/adapters/*.js` (OpenLibrary, Wikidata, OSM)

### Configuration & Infrastructure
- [ ] Update `config/` files for ESM
- [ ] Convert `db-postgres.js` database layer
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
