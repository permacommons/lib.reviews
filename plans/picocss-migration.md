# PicoCSS migration plan (provisional, no compatibility layer)

## Current PureCSS footprint
- Entrypoint: `frontend/styles/vendor.css` imports `purecss/build/pure-min.css` and `purecss/build/grids-responsive-min.css`, pulled in via `frontend/libreviews.ts`.
- Dependency: `purecss` listed in `package.json` alongside Font Awesome; Vite bundles the LESS/CSS.
- Overrides: `frontend/styles/style.less` only references Pure-specific selectors to tweak aligned form labels and set `Noto Sans` on `.pure-g [class*="pure-u"]`, but many custom classes (e.g., `button-rounded`) assume Pure’s base styles.

## Usage patterns (templates + TS)
- Layout grid: `.pure-g` and `.pure-u-*` (including 24th fractions such as `.pure-u-md-14-24`, `.pure-u-lg-10-24`) used across the header/search shell (`views/layout.hbs`) and multi-column forms (review, team, upload wizard).
- Forms: `.pure-form`, `.pure-form-stacked`, `.pure-form-aligned`, `.pure-control-group` structure is pervasive in auth/register/reset, thing/team/review forms; input sizing via `.pure-input-1`, `.pure-input-1-2`, search uses `.pure-input-rounded`.
- Buttons: `.pure-button` with `.pure-button-primary` throughout nav/menu CTAs and submit actions; JS-generated buttons in `frontend/upload-modal.ts`, `frontend/editor-prompt.ts`, and `frontend/review.ts`.
- Tables: `.pure-table` (+ `.pure-table-horizontal`) for invites and account/request management views.
- Misc: `.pure-checkbox` on opt-in lists, `.pure-img` for the logo, plus `.pure-table`/`.pure-form` inside modals.

## Migration approach (draft, breaking-first)
1. Foundation/setup: replace PureCSS imports with PicoCSS in `frontend/styles/vendor.css` (keep Font Awesome) and remove Pure from dependencies; accept baseline shifts first.
2. Semantics for Pico classless mode: introduce structural landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`), favor `<section>/<article>/<aside>` over generic divs for content blocks, tighten form semantics (`<label>` pairing, `<fieldset>/<legend>`, real `<button>` vs `<a>` actions), and ensure tables/lists use proper `<caption>/<thead>/<tbody>/<th scope>` and `<ul>/<ol>` markup so Pico’s base styles apply cleanly. Do this early so the base styles work in our favor before detailed restyling.
3. Grid/layout: rebuild layout wrappers to remove `.pure-g`/`.pure-u-*` reliance (likely custom CSS grid/flex). Start with `views/layout.hbs` header/search and one form-heavy page (review or team) to validate breakpoints and spacing.
4. Forms/buttons: rework form markup/classes to match Pico-friendly structure; recreate stacked/aligned spacing, label alignment, and input sizing without Pure helpers. Refresh button styling (`.pure-button`, `.pure-button-primary`, `button-rounded`) and update JS-rendered buttons in upload modal/editor prompt.
5. Tables & misc components: restyle table views (invites, request management), replace `.pure-checkbox`, and address image sizing currently using `.pure-img`.
6. Cleanup: purge remaining Pure-specific selectors from `frontend/styles/style.less`, remove dead classes/templates, and run full QA (`npm run test`, `npm run lint`, `npm run typecheck`) plus targeted visual checks (desktop/mobile).

## Notes/risks
- Pico lacks a built-in grid/utilities, so a custom grid is needed to preserve the 24-column layouts.
- Form spacing/alignment and rounded search input depend on Pure defaults; explicit replacements are required to avoid spacing/regression issues.
- Start with `views/layout.hbs` and the review/team forms for early validation—they exercise most Pure patterns and will surface gaps quickly.
