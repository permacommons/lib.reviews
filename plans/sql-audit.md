# SQL Audit – Raw SQL In Models And Non-DAL Code

## Scope
- Re-ran a search for inline `SELECT/INSERT/UPDATE/DELETE` inside `models/` (DAL code excluded; tests and maintenance scripts intentionally ignored).
- Goal: replace the remaining raw SQL with generalized DAL helpers (not ad-hoc per-model code).

## Remaining Raw SQL (models/)
- `models/thing.ts:620-677` – File attachment helper selects files with revision guards and inserts into `thing_files` with `ON CONFLICT DO NOTHING`.

## Helper Gaps Blocking Migration
- Many-to-many association helpers that batch `INSERT … ON CONFLICT DO NOTHING` into junction tables (needed for `models/thing.ts` file attachments).
