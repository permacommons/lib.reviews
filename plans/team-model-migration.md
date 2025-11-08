# Team Model Manifest Migration

Objective: bring `models/team.ts` in line with the `defineModel` structure (like `Thing`/`User`), while handling its heavier cross-model usage (Review, User, TeamJoinRequest, TeamSlug) and validation helpers.

## Current Structure
- Uses `createModel` with `teamManifest` inline; statics/instance methods defined as free functions (`getWithData`, `populateUserInfo`, etc.).
- Imports `Review`, `User`, `TeamJoinRequest`, `TeamSlug` directly; this will collide with `Review` once it’s on `defineModel` unless we stage compatibility helpers.
- Several schema validators (`validateTextHtmlObject`, `validateConfersPermissions`, `generateSlugName`) defined at module scope.
- Helper functions for joins (`getTeamMembers`, `getTeamModerators`, `getTeamJoinRequests`, `getTeamReviews`) consume the `Team` constructor directly.

## Migration Plan
- **Adopt manifest helpers**
  - Wrap `teamManifest` with `defineModelManifest` for better type inference.
  - Replace `createModel` with `defineModel`, exporting the constructor and a `TeamInstance` type (`InferInstance<typeof teamManifest>`).
- **Inline statics/instance methods**
  - Move `getWithData` into `staticMethods`, and `populateUserInfo`/`updateSlug` into `instanceMethods` within the manifest to match the Thing/User pattern.
  - Keep helper functions (`getTeamMembers`, etc.) outside the manifest but make them consume the new typed constructor via `this` or a helper accessor.
- **Handle cross-model imports**
  - In the short term, add lazy `getReviewModel` (and similar for other cyclic imports if needed) to avoid TypeScript circular aliases, mirroring the approach used in `review.ts`/`thing.ts`.
  - Longer-term, once manifests are split, replace lazy helpers with direct imports.
- **Keep validators separate**
  - Reuse `validateTextHtmlObject`, `validateConfersPermissions`, `generateSlugName` as pure helpers; ensure their usage inside the manifest doesn’t pull in extra types.
- **Testing & verification**
  - After migrating, run `npm run typecheck:backend` and the relevant team-focused test suites.
  - Spot-check `routes/teams.ts` (or equivalent handlers) to ensure TypeScript inference now sees the new methods correctly.

## Future Enhancements
- Once all models are on `defineModel`, revisit splitting manifests/types from runtime logic to remove the lazy helpers.
- Consider extracting shared join helpers (members/moderators) into a shared module if other models start depending on them.
