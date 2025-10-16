# Modernization Roadmap

This document tracks the lib.reviews dependency strategy while we lift the stack to Node.js 22. Keep entries concise so they can be updated alongside incremental commits.

## CI / Testing Notes
- AVA currently runs with `concurrency: 2` because external adapter tests (OpenStreetMap, etc.) still touch live services. Increase only after those adapters are mocked or a local test double is in place.
- Integration suites close shared resources (RethinkDB, Elasticsearch client) manually; keep this in mind when adding new long-lived connections.

## Current Snapshot
- Audit tool: `npx npm-check-updates` (v19) against the existing package.json.
- Direct dependencies: 62 runtime, 11 dev (73 total).
- Upgrades available: 11 patch, 23 minor, 27 major releases.
- Packages with no maintained upgrade path in the registry: 27 (listed below).

### Legacy / Replacement Candidates
- `bcrypt-nodejs` – unmaintained; replace with actively maintained `bcrypt` or `bcryptjs`.
- `request` / `request-promise-native` – deprecated; migrate to `node-fetch`, `got`, or another well-supported HTTP client.
- `thinky` (and its `rethinkdbdash@~2.3.0` pin) – no activity since 2019; plan to move to the official RethinkDB driver or another persistence layer.
- `greenlock-express@4`, `node-webhooks`, `express-flash`, `remote-ac`, `irc-upd`, `promise-limit`, `es6-promise`, `striptags`, and similar utilities – review individually for maintenance status and Node 22 compatibility before upgrades.
- Asset build pipeline replaced with Vite (2025-10-16); follow-up: prune unused legacy assets under `static/js` and keep the manifest/HMR integration exercised in CI.

### Major Upgrades Requiring Code Changes
| Package | Current | Target | Notes |
|---------|---------|--------|-------|
| `express` | ^4.17.1 | ^5.1.0 | Express 5 introduces async handler support and routing changes; audit middleware and error handling. |
| `body-parser` | ^1.20.2 | ^2.2.0 | Express 5 integrates body parsing differently; coordinate with the express upgrade. |
| `config` | ^1.31.0 | ^4.1.1 | Configuration file format largely compatible, but new version drops Node <14 support and tightens typings. |
| `debug` | ~2.6.7 | ~4.4.3 | Update usage patterns (namespaces are backward compatible). |
| `file-type` | ^3.8.0 | ^21.0.0 | API switched to async/Buffer methods; requires refactor in upload pipelines. |
| `multer` | ^1.4.2 | ^2.0.2 | v2 adopts Promise-based handlers; verify storage adapters. |
| `markdown-it` (+ plugins) | ^13.x | latest | Confirm rendered output stability and custom plugins. |
| `type-is` | ^1.6.18 | ^2.0.1 | Used by Express stack; review any direct calls. |
| Dev tooling (`ava`, `chalk`, `jsdoc`, `supertest`) | various | latest majors | Check breaking changes (e.g., ESM-first packages, dropping older Node versions). |

### Routine Patch/Minor Updates
- Safe to batch once tests cover critical flows: `cookie-parser`, `compression`, `morgan`, `serve-favicon`, `serve-index`, `express-session`, `session-rethinkdb`, `sisyphus.js`, `sprintf-js`, `prosemirror*`, `jquery` and related utilities, `@snyk/protect`, `snyk`, `pre-commit`, `child-process-promise`.

### No Registry Updates Detected
`babel-core`, `babel-preset-env`, `csurf`, `escape-html`, `express-useragent`, `i18n` (git dependency), `jquery-modal`, `markdown-it-html5-media`, `passport-local`, `remote-ac`, etc. – confirm whether to replace, fork, or pin with explicit rationale.

## Incremental Update Plan (Checklist)

- [x] **Baseline Node 22 Support**
  - [x] Update local/tooling docs to state Node.js 22.
  - [x] Run tests under Node 22 to capture immediate runtime breaks. *(2025-10-11: AVA suite passes locally on Node 22; requires Elasticsearch stub or skip but no regressions observed.)*
  - [x] Add CI matrix entries for Node 22 (retain Node 20 temporarily if needed). *(Added `.github/workflows/ci.yml` with Node 22/20 jobs installing RethinkDB and running build/test.)*

- [x] **Low-Risk Batch (patch/minor)**
  - [x] Upgrade packages listed in “Routine Patch/Minor Updates”. *(2025-10-11: Applied `ncu --target minor` + `npm install`, covering cookie-parser, compression, elasticsearch, express-session, session-rethinkdb, sisyphus.js, sprintf-js, @snyk/protect, snyk, child-process-promise, pre-commit, jquery (+ powertip), morgan, rethinkdbdash, serve-favicon, serve-index, prosemirror suite, etc.)*
  - [x] Refresh lockfile, run unit/integration tests, and smoke test the asset pipeline. *(2025-10-11: package-lock regenerated; `npm run build` (Grunt at the time) and `npm run test` succeed on Node 22 with expected Elasticsearch warnings.)*
  - [x] Commit with clear scope (`chore(deps): patch/minor runtime updates for Node 22`).

- [x] **i18n Upgrade**
  - [x] Switch from the `eloquence/i18n-node` fork to upstream `i18n@^0.15.2`. *(2025-10-15: dependency and lockfile updated, default locale explicitly configured in `app.js`.)*
  - [x] Add regression coverage to verify default-locale fallback for missing strings and plurals. *(New AVA suite `tests/8-i18n-fallbacks.mjs`.)*
  - [x] Full `npm run test` on Node 22 passes; Elasticsearch warnings remain expected due to missing local service.

- [x] **Dev Toolchain Refresh**
  - [x] Upgrade `ava` to ^6.4.1 and migrate the test suite to ESM (`*.mjs`), including helper/fixture refactors and disabling i18n auto-reload when `NODE_CONFIG_DISABLE_WATCH` is set to avoid lingering FS watchers in AVA workers. *(2025-10-12: Adapter tests now run on local mocks, so AVA concurrency increased to 4 without flakes.)*
  - [x] Upgrade `supertest`, `chalk`, `jsdoc`, `grunt`, `grunt-babel`. *(2025-10-11: Bumped to supertest@^7, chalk@^5, jsdoc@^4, confirmed grunt@^1.6.1 compatibility, upgraded grunt-babel@^8, and migrated build to @babel/core/@babel/preset-env. 2025-10-14: dropped pm2 in favor of systemd units; npm scripts now call `node bin/www.js` directly.)*
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

- [x] **Legacy Replacements**
  - [x] Swap `bcrypt-nodejs` → `bcrypt` (or `bcryptjs`) and refactor auth helpers/tests.
  - [x] Replace `request`/`request-promise-native` with a modern HTTP client; adjust any Promise wrapping. *(2025-10-13: Migrated metadata adapters to native fetch with `AbortSignal.timeout` (Node ≥17.3) covering timeouts, and removed deprecated dependencies.)*
  - [x] Decide on the future of `thinky`: upgrade to a maintained fork or migrate to the official `rethinkdb` driver / alternative ORM. *(2025-10-13: vendored thinky under orm/ for now; long term plan is to migrate to postgres)
  - [x] Evaluate `greenlock-express`, `node-webhooks`, `remote-ac`, `i18n` git dependency, and other utilities for maintained successors. *(2025-10-14: `greenlock-express` last shipped in 2020; plan to read certs issued via Certbot directly instead of keeping the embedded ACME flow. `node-webhooks` (2019) still pulls in `request`; we can replace it with a small fetch-based dispatcher. `remote-ac` (2018) lags on accessibility—evaluate `accessible-autocomplete@3` vs `@tarekraafat/autocomplete.js`. The `i18n` fork pins 0.8.3; upstream 0.15.2 keeps the API we use, so we should migrate off the git dependency. `express-flash` remains frozen at 0.0.2 (2013) and may be replaced once we have an in-house flash helper.)*
    - [x] Reimplement webhook dispatching without `node-webhooks` using Node 22's global `fetch`, retries, and logging; add integration coverage. *(2025-10-14: Replaced with `WebHookDispatcher` utility using `fetch` + timeouts and AVA coverage mirroring the IRC bot webhook.)*
    - [x] Swap the frontend autocomplete widget (`remote-ac`) for a maintained alternative and refactor the adapter surface to preserve current UX. *(2025-10-14: Replaced the dependency with an in-repo `AC` widget featuring ARIA support; the Vite `lib` entry imports `frontend/lib/ac.js`, and AVA coverage (`tests/7-autocomplete.mjs`) guards rendering + triggering APIs.)*
    - [x] Upgrade to the published `i18n@^0.15.2`, drop the git pin, and ensure watcher/test configuration stays stable on Node 22.
    - [x] Replace `greenlock-express` with a Certbot-managed TLS workflow (load cert/key from disk, handle reloads), documenting operational steps; tackle this last since it is the trickiest migration. *(2025-10-14: Removed `greenlock-express`; `bin/www.js` now reads Certbot-managed key/cert paths from config and serves HTTPS directly on port 443 by default. Add a follow-up to watch for renewals and reload certificates without restart.)*

- [ ] **Build Pipeline Modernization**
  - [x] Capture then-legacy Grunt asset inventory (copy/browserify/babel/concat/uglify outputs) and map consumers in `static/` and `views/layout.hbs`. *(2025-10-16: documented generated bundles `static/js/lib(.min).js`, `static/js/editor(.min).js`, Browserify outputs `build/editor-es6-bundle.js`, `build/review-es6-bundle.js`, and vendor copies sourced via `copy` task ahead of the migration.)*
  - [x] Land initial Vite spike bundling `frontend/libreviews.js` → `build/vite/js/libreviews.js` with `vite.config.mjs` + `npm run vite:build` for validation. *(2025-10-16: Vite build succeeds locally on Node 22; Grunt remained temporarily as fallback until full cut-over.)*
  - [x] Extend Vite inputs to cover `frontend/editor.js`, `frontend/review.js`, `frontend/upload.js`, and shared vendor code while preserving global jQuery/prosemirror expectations. *(2025-10-16: `vite.config.mjs` now emits hashed bundles + `frontend/entries/*.js`, and extracts ProseMirror styles into `build/vite/assets/editor-*.css`.)*
  - [x] Integrate Vite with Express (manifest endpoint, `/assets` static handler, middleware-mode dev server for HMR) and decommission Grunt. *(2025-10-16: `app.js` loads the manifest, injects `<script type="module">`/CSS via `client-assets`, and exposes `/assets/manifest.json` for development tooling.)*
  - [x] Follow-ups: Prune unused legacy files under `static/js/` and rely on Vite's generated preload helper for shared chunks. *(2025-10-16: removed the old Grunt outputs in `static/js/`; dynamic imports now ride on Vite's runtime preload helper, so no manual modulepreload tags needed.)*
  - [ ] Modernize legacy frontend modules (`frontend/*.js`) into true ES modules so Vite can target them directly (drop `entries/` wrappers). Scope: replace global IIFEs with exported setup functions, remove reliance on `window.libreviewsReady`, and adjust template helpers to consume the new exports. Coordinate with jQuery/global tooling assumptions before tackling.

## Tracking & Follow-Up
- [ ] Update this document when each stage lands in a mergeable commit.
- [ ] Note compatibility gotchas discovered during upgrades (e.g., API changes, polyfills removed).
- [ ] Record decisions for replacing unmaintained packages so future contributors see the rationale.
