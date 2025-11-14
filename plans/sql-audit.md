# SQL Audit – Raw SQL In Models And Non-DAL Code

## Scope & Method
- Searched `models/` and the rest of the codebase (excluding `dal/`) for inline `SELECT/INSERT/UPDATE/DELETE` statements.
- Manually inspected every hit to understand its purpose and grouped them by recurring patterns.
- Highlighted patterns with more than one caller so we can replace ad-hoc SQL with DAL-level helpers.

## Reusable Patterns That Deserve DAL Helpers

### 1. Declarative projection/shape requests
- Current use: `models/review.ts:354-383`, `models/invite-link.ts:77-101`, and `models/team.ts:205-260` each restate which columns are needed from `users` and then hand-normalize them.
- Recommendation: extend the DAL query builder so callers can describe reusable “shapes” (e.g., `userPublicProfile`, `userMinimal`) and have the builder expand them into `SELECT` lists plus post-processing. Models would then ask for `User.query().selectShape('publicProfile').whereIn('id', ids)` instead of hard-coding SQL.
- Incremental plan: (1) add shape support to the DAL plus a first `userPublicProfile` definition; (2) migrate the Review + Invite Link code; (3) encourage future shapes (teams, things) so we can phase out copy/pasted projections across the codebase.

### 2. Relationship-aware batch loaders
- Current use: `_getReviewTeams` (`models/review.ts:569-591`), `_attachUserTeams` (`models/user.ts:303-352`), and Team helpers (`models/team.ts:205-320`, `models/team.ts:336-410`) manually express the same join logic with different source tables.
- Recommendation: the manifests already describe these relations (e.g., `models/manifests/team.ts` defines `members`/`moderators`). The gap is that only the DAL query builder consumes that metadata. We should extend the DAL with generic primitives (`buildJoinPlan`, `batchLoadRelated`) that can execute an existing relation definition for arbitrary ID sets, so ad-hoc SQL disappears without duplicating the relationship info.
- Incremental plan: (1) expose the relation definitions that already live in manifests through a DAL helper interface; (2) wire up a batch loader that takes `{ relation: teamManifest.relations.members, ids }`; (3) migrate Review + Team + User logic to call the loader; (4) repeat for any other relation where we still reach for raw SQL.

### 3. Reusable paginated query plans
- Current use: both `Review.getFeed` and `Team.getTeamReviews` reimplement the same “limit + 1 with cursor” pattern.
- Recommendation: teach the DAL about standard pagination plans (offset-date cursor, ID cursor, etc.) so models can request `dal.pagination.limitPlusOne({ baseQuery, cursorField, direction })`. The DAL would return the rows, a `hasMore` flag, and the next cursor token, removing the need for raw SQL per feed.
- Incremental plan: (1) add a pagination builder that operates on DAL `QueryBuilder` instances; (2) wrap `Review.getFeed` with it while keeping the public API; (3) update `Team.getTeamReviews` to reuse the same plan; (4) promote the builder for any future feeds (blog posts, files, etc.).

### 4. Centralized revision filtering and soft-delete enforcement
- Current use: almost every raw statement repeats the `_old_rev_of`/`_rev_deleted` guard, but some helper functions omit it.
- Recommendation: enforce revision filters at the DAL layer (e.g., default scopes on models, `QueryBuilder.withActiveRevision()`), so callers only opt out explicitly. That keeps behavior consistent and removes the need to inject the clause manually.
- Incremental plan: (1) make active-revision filtering the default in the DAL query builder; (2) supply an escape hatch for legacy SQL when required; (3) migrate raw SQL callers gradually by swapping them to builder-based queries, shrinking the set of manual statements we must audit.

### 5. General-purpose aggregate APIs
- Current use: review averages/counts (`models/thing.ts:486-539`, `models/team.ts:397-404`) and similar metrics duplicate aggregate SQL.
- Recommendation: expose an aggregate abstraction inside the DAL (e.g., `Review.aggregate({ groupBy: 'thing_id', columns: { avgRating: avg('star_rating'), reviewCount: count('*') } })`) so models can request per-entity metrics declaratively.
- Incremental plan: (1) add aggregate helpers to the DAL once (returning typed results); (2) migrate Thing + Team metrics; (3) reuse the same system for future stats (e.g., user contribution counts) without resorting to ad-hoc SQL.

## Single-Use Or Script-Only SQL (track but lower priority)
- `maintenance/dump-public-data.ts:294-386` runs raw SQL via `psql` to build export views—isolated to this admin tool.
- `models/thing-slug.ts:55-138` combines several bespoke queries to resolve slug conflicts; logic is tightly coupled to slug creation and is not reused elsewhere.
- `models/file.ts:29-41`, `models/invite-link.ts:22-152`, `models/blog-post.ts:43-110`, `models/thing.ts:629-704`, and `models/review.ts:90-143` each contain single-purpose selects/inserts where no second caller currently exists; keep them in place until another consumer materializes.
- Tests under `tests/**` intentionally use raw SQL for fixtures/assertions and are outside the DAL migration scope.

## Suggested Next Steps
1. Implement “shape” definitions plus relationship metadata inside the DAL so models can ask for structured projections/joins without SQL.
2. Introduce generic pagination builders and aggregate helpers, then migrate `Review.getFeed`, `Team.getTeamReviews`, and Thing metrics to them.
3. Once the DAL has the generalized primitives, sweep the remaining raw SQL and swap each call site to the new abstractions, keeping only true edge cases (e.g., maintenance scripts) on raw SQL.
