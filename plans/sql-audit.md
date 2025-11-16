# SQL Audit – Raw SQL In Models And Non-DAL Code

## Scope
- Re-ran a search for inline `SELECT/INSERT/UPDATE/DELETE` inside `models/` (DAL code excluded; tests and maintenance scripts intentionally ignored).
- Goal: replace the remaining raw SQL with generalized DAL helpers (not ad-hoc per-model code).

## Remaining Raw SQL (models/)
- `models/review.ts:405-439` and `models/review.ts:520-544` – Team joins for review feeds and single-review hydration manually query `review_teams` → `teams`.
- `models/team.ts:205-236` and `models/team.ts:246-279` – Member/moderator loaders read join tables (`team_members`, `team_moderators`) then hydrate user views.
- `models/team.ts:303-343` – Join request loader selects from `team_join_requests` and optionally batches user lookups.
- `models/invite-link.ts:30-152` – Pending, redeemed, and fetch-by-id lookups are expressed as raw selects on `invite_links`.
- `models/thing.ts:620-677` – File attachment helper selects files with revision guards and inserts into `thing_files` with `ON CONFLICT DO NOTHING`.

## Helper Gaps Blocking Migration
- Relation-aware batch loaders for join tables (e.g., review↔team, team↔user) that honor manifest metadata and ordering, so manual `JOIN` SQL disappears.
- Many-to-many association helpers that batch `INSERT … ON CONFLICT DO NOTHING` into junction tables.
