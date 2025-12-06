Migrated frontend styling from PureCSS + LESS to PicoCSS + PostCSS,
modernizing the CSS architecture, standardizing on a "reviews + sidebar"
desktop layout for many pages, adding light/dark mode, and making some pages 
more mobile-friendly.

This design draws heavy inspiration from these mock-ups by Nortix, 
especially the sidebar format:

https://nortix.blog/lib.reviews/index.html

## Major Changes

### Framework & Build
- Replaced PureCSS with PicoCSS (classless semantic CSS framework)
- Migrated from LESS to vanilla CSS with PostCSS (nesting, mixins)
- Updated Handlebars templates to use semantic HTML where appropriate
- Disabled caching in dev mode to aid in debugging

### Theme System
- Added user theme preference support (light/dark/system) with database
  migration
- Implemented theme switcher (persists to cookie or user preference)
- Structured CSS to treat light mode as default, dark mode as override
- Created dark mode logo variant

### Mobile changes
- Added mobile-friendly version of "invite links" page
- Added a mobile/tablet-friendly navigation menu (no JS required)

