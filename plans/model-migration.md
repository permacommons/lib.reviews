# Remaining Model Manifest Migrations

## Current Status

The primary models (`user`, `team`, `thing`, `review`, `blog-post`, `user-meta`, and `team-join-request`) now use `defineModel` + `defineModelManifest`. Typed manifests expose the canonical constructor, instance helpers, and relation metadata without manual casts. The remaining legacy modules still call `createModel` directly and miss out on the typed ergonomics, manifest-driven lazy loading, and shared helper wiring.

## Scope

Migrate the remaining DAL models to the manifest pattern. Each module should:

- Export a manifest created via `defineModelManifest`.
- Instantiate the constructor with `defineModel(manifest)`.
- Re-export `InferInstance<typeof manifest>` aliases for downstream typing.
- Inline public static/instance methods inside the manifest definition and keep only local helper functions outside.
- Preserve any lazy-loading patterns that break circular dependencies (for example, loader helpers that import `Team` or `Thing` on demand).
- Maintain runtime behaviour, particularly validation semantics, relation metadata, and exposed helpers.

## Remaining Targets

1. `models/file.ts` – revisioned asset metadata with sizable static helper surface.
2. `models/invite-link.ts` – invitation lifecycle helpers, including claims/expiration.
3. `models/team-slug.ts` – slug registry for teams; needs manifest relations to `teams`.
4. `models/thing-slug.ts` – slug registry for things; mirrors the team variant but touches review bootstrapping.

## Task Breakdown

### `models/file.ts`
- Wrap the existing manifest object in `defineModelManifest` and migrate the constructor to `defineModel`.
- Ensure static helpers (`getByChecksum`, `saveUpload`, etc.) live under the `staticMethods` block with typed `this` access.
- Move instance helpers (for example, `populateUserInfo`) into the `instanceMethods` block so the `ThisType` inference keeps working.
- Retain JSONB schema validation and virtual field definitions exactly as-is.
- Update imports to pull `InferInstance` for the exported `FileInstance` alias and drop legacy casts.

### `models/invite-link.ts`
- Convert the manifest definition to `defineModelManifest` and rebuild the model with `defineModel`.
- Inline static methods (`generate`, `redeem`, `getPendingForUser`, etc.) inside `staticMethods`, relying on typed `this` rather than manual casts.
- Export `InviteLinkInstance` using `InferInstance<typeof inviteLinkManifest>`.
- Double-check any helper functions shared with `User` to ensure lazy imports still avoid cycles.

### `models/team-slug.ts`
- Replace `createModel` usage with `defineModelManifest`/`defineModel`.
- Ensure relation metadata (linking slugs to teams) survives the migration and that `getByName` continues returning typed instances.
- Export `TeamSlugInstance` for downstream modules that hydrate slug data alongside teams.
- Keep any helper utilities (for example, canonicalization) outside the manifest, but move reusable public methods into `staticMethods`.

### `models/thing-slug.ts`
- Mirror the `team-slug.ts` conversion while respecting lazy imports into `Thing`/`Review` modules to avoid circular dependencies.
- Migrate static helpers such as `getByName`, `resolve`, and `createForThing` into the manifest definition.
- Export a `ThingSlugInstance` alias for typing.

## Validation

- `npm run typecheck:backend`
- `npm tests`
- Spot-check routes or scripts that rely on each migrated model (for example, slug resolution, invite flows, and file uploads) to ensure no regressions in behaviour or permissions.
- Confirm generated manifests continue to register during bootstrap without introducing circular import failures.
