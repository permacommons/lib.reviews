# Modernization Roadmap

This document tracks the lib.reviews dependency strategy while we lift the stack to Node.js 22. Keep entries concise so they can be updated alongside incremental commits.

## CI / Testing Notes
- AVA currently runs with `concurrency: 2` because external adapter tests (OpenStreetMap, etc.) still touch live services. Increase only after those adapters are mocked or a local test double is in place.
- Integration suites close shared resources (RethinkDB, Elasticsearch client) manually; keep this in mind when adding new long-lived connections.

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

- [x] **Low-Risk Batch (patch/minor)**
  - [x] Upgrade packages listed in “Routine Patch/Minor Updates”. *(2025-10-11: Applied `ncu --target minor` + `npm install`, covering browserify, cookie-parser, compression, elasticsearch, express-session, session-rethinkdb, sisyphus.js, sprintf-js, @snyk/protect, snyk, child-process-promise, pre-commit, jquery (+ powertip), morgan, rethinkdbdash, serve-favicon, serve-index, prosemirror suite, etc.)*
  - [x] Refresh lockfile, run unit/integration tests, and smoke test the Grunt pipeline. *(package-lock regenerated; `npm run build` and `npm run test` succeed on Node 22 with expected Elasticsearch warnings.)*
  - [x] Commit with clear scope (`chore(deps): patch/minor runtime updates for Node 22`).

- [x] **Dev Toolchain Refresh**
  - [x] Upgrade `ava` to ^6.4.1 and migrate the test suite to ESM (`*.mjs`), including helper/fixture refactors and disabling i18n auto-reload when `NODE_CONFIG_DISABLE_WATCH` is set to avoid lingering FS watchers in AVA workers. *(2025-10-12: Adapter tests now run on local mocks, so AVA concurrency increased to 4 without flakes.)*
  - [x] Upgrade `supertest`, `chalk`, `jsdoc`, `pm2`, `grunt`, `grunt-babel`. *(2025-10-11: Bumped to supertest@^7, chalk@^5, jsdoc@^4, pm2@^6, confirmed grunt@^1.6.1 compatibility, upgraded grunt-babel@^8, and migrated build to @babel/core/@babel/preset-env.)*
  - [x] Address breaking changes (e.g., AVA 6 → pure ESM config, Chalk 5 ESM, PM2 config adjustments). *(Adjusted Grunt Babel preset to @babel/preset-env and verified jsdoc pipeline.)*
  - [x] Ensure scripts (`npm test`, `npm run build`) still succeed. *(2025-10-11: Build/devdocs run clean; npm test and `npm run start-dev` confirmed outside sandbox.)*

- [x] **Runtime Breaking Changes**
  - [x] Coordinate Express 5 + body-parser 2 migration (router error handling, async middleware, CSRF setup). *(2025-10-11: Upgraded to express@^5.1.0 + body-parser@^2.2.0, updated API error handler to detect body-parser parse failures, and verified build/test/PM2 flows outside sandbox.)*
  - [x] Update `config`, `debug`, `multer`, `file-type`, `markdown-it` (and plugins) in focused commits with regression tests.
    - [x] Upgrade `config` to ^4.1.1 and `debug` to ^4.4.3; validated `npm run build` and `npm test` outside the sandbox (2025-10-12).
    - [x] Upgrade `multer` → ^2.x with async storage handler updates. *(2025-10-12: Bumped to multer@^2.0.2; existing disk storage callbacks remain compatible—new AVA integration test covers `/api/actions/upload` flow.)*
    - [x] Migrate `file-type` usage to async API and bump dependency. *(2025-10-12: Upgraded to file-type@^21, removed read-chunk, and updated upload validation to async detection with integration test coverage.)*
    - [x] Update `markdown-it` and plugins, confirming rendered output parity. *(2025-10-12: Upgraded to markdown-it@^14 + markdown-it-container@^4; refreshed `markdown-it-html5-media` to 0.8.0 (Node ≥20, peer markdown-it >=13) with new regression test `tests/5-markdown.mjs` for spoiler/media output.)*
  - [x] Track required code changes directly in the affected modules (`app.js`, `routes/*`, upload handlers, markdown renderers).

- [ ] **Legacy Replacements**
  - [x] Swap `bcrypt-nodejs` → `bcrypt` (or `bcryptjs`) and refactor auth helpers/tests.
  - [x] Replace `request`/`request-promise-native` with a modern HTTP client; adjust any Promise wrapping. *(2025-10-13: Migrated metadata adapters to native fetch with `AbortSignal.timeout` (Node ≥17.3) covering timeouts, and removed deprecated dependencies.)*
  - [x] Decide on the future of `thinky`: upgrade to a maintained fork or migrate to the official `rethinkdb` driver / alternative ORM. *(2025-10-13: vendored thinky under orm/ for now; long term plan is to migrate to postgres)
  - [ ] Evaluate `greenlock-express`, `node-webhooks`, `remote-ac`, `i18n` git dependency, and other utilities for maintained successors.

- [ ] **Build Pipeline Modernization (Longer-Term)**
  - [ ] Map Grunt tasks to a modern bundler (Vite, esbuild, or Webpack) once runtime deps are stable.
  - [ ] Gradually replace Grunt plugins as the new pipeline comes online; avoid disruptive switches until prior stages land.

## Tracking & Follow-Up
- [ ] Update this document when each stage lands in a mergeable commit.
- [ ] Note compatibility gotchas discovered during upgrades (e.g., API changes, polyfills removed).
- [ ] Record decisions for replacing unmaintained packages so future contributors see the rationale.
