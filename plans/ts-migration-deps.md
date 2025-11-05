# Type Migration Dependency Audit

_Updated: 2025-10-31_

This inventory lists runtime dependencies that require additional type definitions (either via DefinitelyTyped or custom ambient
modules) before the TypeScript migration can progress safely. Package versions reference `package.json` at the time of this audi
t.

## Type packages available on npm

| Runtime package | Installed version | Recommended type package | Latest type version | Notes |
| --- | --- | --- | --- | --- |
| compression | ^1.8.1 | @types/compression | 1.8.1 | Needed for Express middleware typings. |
| config | ^4.1.1 | @types/config | 3.3.5 | Covers configuration helper API. |
| connect-pg-simple | ^10.0.0 | @types/connect-pg-simple | 7.0.3 | Required for session store constructor types. |
| cookie-parser | ~1.4.7 | @types/cookie-parser | 1.4.10 | Enables typed cookie middleware. |
| elasticsearch | ^16.7.3 | @types/elasticsearch | 5.0.43 | Existing client is deprecated; types remain available. |
| express-useragent | ^1.0.15 | @types/express-useragent | 1.0.5 | Provides request augmentation typings. |
| hbs | ^4.2.0 | @types/hbs | 4.0.5 | Supports Express view engine helpers. |
| i18n | ^0.15.2 | @types/i18n | 0.13.12 | Supplies typings for localization helpers. |
| is-svg | ^4.4.0 | @types/is-svg | 4.0.1 | Ensures SVG validation helper is typed. |
| is-uuid | ^1.0.2 | @types/is-uuid | 1.0.2 | Adds UUID helper typings. |
| jsonfile | ^2.4.0 | @types/jsonfile | 6.1.4 | Needed for CLI tooling that manipulates JSON files. |
| linkify-html | ^4.3.2 | @types/linkifyjs | 2.1.7 | Plugin piggybacks on core linkify types. |
| markdown-it-container | ^4.0.0 | @types/markdown-it-container | 2.0.10 | Required for custom container renderer definitions. |
| morgan | ^1.10.1 | @types/morgan | 1.9.10 | Restores request logging typings. |
| passport-local | ^1.0.0 | @types/passport-local | 1.0.38 | Align with Passport strategy generics. |
| serve-favicon | ~2.5.1 | @types/serve-favicon | 2.5.7 | Provides Express middleware typing. |
| serve-index | ^1.9.1 | @types/serve-index | 1.9.4 | Supports static directory listing routes. |
| sprintf-js | ^1.1.3 | @types/sprintf-js | 1.1.4 | Used in templating helpers. |
| striptags | ^3.2.0 | @types/striptags | 3.1.1 | For sanitization utilities. |
| type-is | ^1.6.18 | @types/type-is | 1.6.7 | Completes body parser typing story. |

## No maintained type packages found

The following dependencies do not expose TypeScript definitions and have no DefinitelyTyped packages (as of this audit). We will
need to author minimal ambient declarations or consider alternative libraries:

- csrf-sync (`npm view @types/csrf-sync` → 404)
- helmet-csp (`npm view @types/helmet-csp` → 404)
- irc-upd (`npm view @types/irc-upd` → 404)
- jquery-modal (`npm view @types/jquery-modal` → 404; also `@types/jquery.modal` missing)
- jquery-powertip (`npm view @types/jquery-powertip` → 404)
- linkify-html (no dedicated types; rely on plugin ambient module)
- markdown-it-html5-media (no @types package)
- promise-limit (no @types package)
- sisyphus.js (no @types package)
- unescape-html (`npm view @types/unescape-html` → 404)

## Next steps

1. Add the recommended `@types/*` packages above to `devDependencies` as modules graduate to TypeScript.
2. Draft ambient module declarations under `types/legacy/` for packages without community typings.
3. Re-run this audit after major dependency upgrades to keep the checklist current.
