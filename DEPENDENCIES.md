# Dependency Modernization Plan

This document tracks the lib.reviews dependency strategy while we lift the stack to Node.js 22. Keep entries concise so they can be updated alongside incremental commits.

## Current Snapshot
- Audit tool: `npx npm-check-updates` (v19) against the existing package.json.
- Direct dependencies: 78 runtime, 10 dev (88 total).
- Upgrades available: 11 patch, 23 minor, 27 major releases.
- Packages with no maintained upgrade path in the registry: 27 (listed below).

### Legacy / Replacement Candidates
- `bcrypt-nodejs` – unmaintained; replace with actively maintained `bcrypt` or `bcryptjs`.
- `request` / `request-promise-native` – deprecated; migrate to `node-fetch`, `got`, or another well-supported HTTP client.
- `thinky` (and its `rethinkdbdash@~2.3.0` pin) – no activity since 2019; plan to move to the official RethinkDB driver or another persistence layer.
- `greenlock-express@4`, `node-webhooks`, `express-flash`, `remote-ac`, `irc-upd`, `promise-limit`, `es6-promise`, `striptags`, `i18n` git dependency, and similar utilities – review individually for maintenance status and Node 22 compatibility before upgrades.
- Asset pipeline packages tied to Grunt/Browserify (`grunt-browserify`, `grunt-contrib-copy`, `less-middleware`, `jquery-modal`, etc.) still work but block modernization; migration strategy to a contemporary bundler will determine their replacement timeline.

### Major Upgrades Requiring Code Changes
| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `express` | ^4.17.1 | ^5.1.0 | Express 5 introduces async handler support and routing changes; audit middleware and error handling. |
| `body-parser` | ^1.20.2 | ^2.2.0 | Express 5 integrates body parsing differently; coordinate with the express upgrade. |
| `config` | ^1.31.0 | ^4.1.1 | Configuration file format largely compatible, but new version drops Node <14 support and tightens typings. |
| `debug` | ~2.6.7 | ~4.4.3 | Update usage patterns (namespaces are backward compatible). |
| `file-type` | ^3.8.0 | ^21.0.0 | API switched to async/Buffer methods; requires refactor in upload pipelines. |
| `multer` | ^1.4.2 | ^2.0.2 | v2 adopts Promise-based handlers; verify storage adapters. |
| `module-deps`, `load-grunt-tasks`, `grunt-*` | various | latest majors | Ensure Grunt tasks still run; some plugins drop legacy Node support. |
| `markdown-it` (+ plugins) | ^13.x | latest | Confirm rendered output stability and custom plugins. |
| `type-is` | ^1.6.18 | ^2.0.1 | Used by Express stack; review any direct calls. |
| Dev tooling (`ava`, `chalk`, `jsdoc`, `pm2`, `supertest`, `grunt-babel`) | various | latest majors | Check breaking changes (e.g., ESM-first packages, dropping older Node versions). |

### Routine Patch/Minor Updates
- Safe to batch once tests cover critical flows: `browserify`, `cookie-parser`, `compression`, `morgan`, `serve-favicon`, `serve-index`, `express-session`, `session-rethinkdb`, `sisyphus.js`, `sprintf-js`, `prosemirror*`, `jquery` and related utilities, `@snyk/protect`, `snyk`, `pre-commit`, `child-process-promise`.

### No Registry Updates Detected
`babel-core`, `babel-preset-env`, `csurf`, `escape-html`, `express-useragent`, `grunt-contrib-copy`, `i18n` (git dependency), `jquery-modal`, `less-middleware`, `markdown-it-html5-media`, `passport-local`, `remote-ac`, `uglify-save-license`, etc. – confirm whether to replace, fork, or pin with explicit rationale.

## Incremental Update Plan (Checklist)

- [x] **Baseline Node 22 Support**
  - [x] Update local/tooling docs to state Node.js 22.
  - [x] Run tests under Node 22 to capture immediate runtime breaks. *(2025-10-11: AVA suite passes locally on Node 22; requires Elasticsearch stub or skip but no regressions observed.)*
  - [x] Add CI matrix entries for Node 22 (retain Node 20 temporarily if needed). *(Added `.github/workflows/ci.yml` with Node 22/20 jobs installing RethinkDB and running build/test.)*

- [ ] **Low-Risk Batch (patch/minor)**
  - [ ] Upgrade packages listed in “Routine Patch/Minor Updates”.
  - [ ] Refresh lockfile, run unit/integration tests, and smoke test the Grunt pipeline.
  - [ ] Commit with clear scope (`chore(deps): patch/minor runtime updates for Node 22`).

- [ ] **Dev Toolchain Refresh**
  - [ ] Upgrade `ava`, `supertest`, `chalk`, `jsdoc`, `pm2`, `grunt`, `grunt-babel`.
  - [ ] Address breaking changes (e.g., AVA 6 → pure ESM config, Chalk 5 ESM, PM2 config adjustments).
  - [ ] Ensure scripts (`npm test`, `npm run build`) still succeed.

- [ ] **Runtime Breaking Changes**
  - [ ] Coordinate Express 5 + body-parser 2 migration (router error handling, async middleware, CSRF setup).
  - [ ] Update `config`, `debug`, `multer`, `file-type`, `markdown-it` (and plugins) in focused commits with regression tests.
  - [ ] Track required code changes directly in the affected modules (`app.js`, `routes/*`, upload handlers, markdown renderers).

- [ ] **Legacy Replacements**
  - [ ] Swap `bcrypt-nodejs` → `bcrypt` (or `bcryptjs`) and refactor auth helpers/tests.
  - [ ] Replace `request`/`request-promise-native` with a modern HTTP client; adjust any Promise wrapping.
  - [ ] Decide on the future of `thinky`: upgrade to a maintained fork or migrate to the official `rethinkdb` driver / alternative ORM.
  - [ ] Evaluate `greenlock-express`, `node-webhooks`, `remote-ac`, `i18n` git dependency, and other utilities for maintained successors.

- [ ] **Build Pipeline Modernization (Longer-Term)**
  - [ ] Map Grunt tasks to a modern bundler (Vite, esbuild, or Webpack) once runtime deps are stable.
  - [ ] Gradually replace Grunt plugins as the new pipeline comes online; avoid disruptive switches until prior stages land.

## Tracking & Follow-Up
- [ ] Update this document when each stage lands (include commit references).
- [ ] Note compatibility gotchas discovered during upgrades (e.g., API changes, polyfills removed).
- [ ] Record decisions for replacing unmaintained packages so future contributors see the rationale.
