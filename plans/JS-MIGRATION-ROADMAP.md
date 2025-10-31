# Migration Roadmap: ESM → TypeScript → Biome

This document tracks the three-phase migration of lib.reviews to modern tooling.

## Phase 1: CommonJS -> ESM migraiton

Completed.

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
- [ ] Rename `.js` test files to `.ts`
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
