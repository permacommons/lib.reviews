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
- [ ] Convert remaining models that back reviews and assets (`models/thing`, `models/thing-slug`, `models/review`, `models/blog-post`, `models/file`, `models/invite-link`).
  - [x] `models/thing`, `models/thing-slug`
- [ ] Remove the temporary `.js` re-export shims for `util/` helpers once DAL
  imports compile against the native TypeScript sources.


#### Wave 3 — HTTP surface area
- [ ] Migrate Express middleware in `bootstrap/` and `routes/middleware/`.
- [ ] Update middleware/route imports to target `.ts` utilities directly, then
  delete the compatibility proxies in `util/*.js`.
- [ ] Convert route handlers directory-by-directory (`routes/reviews`, `routes/users`, `routes/wiki`).
- [ ] Add type-safe request/response objects using `@types/express` generics and custom `Locals` interfaces.

#### Wave 4 — frontend
- [ ] Convert frontend entry points in `frontend/` to `.ts`
- [ ] Wrap legacy jQuery usage with typed helper modules to minimize `any` leakage.
- [ ] Define module augmentations for ProseMirror and other editor plugins.
- [ ] Update Vite config to emit type definitions for shared frontend utilities.

#### Wave 5 — tests & tooling
- [ ] Rename `.js` test files under `tests/` to `.ts` and replace CommonJS imports.
- [ ] Add TypeDoc coverage checks for the migrated util modules to ensure
  comments stay in sync with the runtime behaviour.
- [ ] Create factory helpers with explicit types for fixtures and test doubles.
- [ ] Ensure AVA configuration uses `ts-node/register` and add a `typecheck` npm script that runs `tsc --project tsconfig.tests.json --noEmit`.

#### Wave 6 — strictness hardening
- [ ] Turn on `noImplicitAny`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` sequentially.
- [ ] Add Biome equivalent of `eslint-plugin-tsdoc`  to enforce documentation on exported symbols.
- [ ] Remove remaining `@ts-ignore` directives and replace with refined types.
- [ ] Enable `strict: true` once the error count is manageable (<50 outstanding issues).

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
