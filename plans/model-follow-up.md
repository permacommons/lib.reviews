# Model Manifest Follow-up Tasks

The remaining migrations landed the manifest pattern across all DAL models, but a few cleanups will help tighten ergonomics and typing consistency:

- **Normalize manifest statics** – audit each model for ad-hoc casts to `_createInstance` or DAL internals and replace them with typed helper statics (for example, `createFromRow`). This eliminates local `unknown` assertions while keeping bootstrapping behaviour intact.
- **Unify instance helper signatures** – ensure `populateUserInfo`-style helpers consistently accept typed user payloads (`UserInstance` or narrowed interfaces) instead of `Record<string, any>`, allowing route handlers to consume strongly typed data.
- **Re-export constructor types** – expose `type FooModel = InferConstructor<typeof fooManifest>` alongside `FooInstance` so downstream modules can consume typed statics without repeating inference boilerplate.
- **Retire legacy query helpers** – sweep for lingering ReQL-style `filter(row => …)` usage and migrate callsites to the manifest-driven query helpers (`filterWhere`, `ops.containsAny`, etc.) to finalize the DAL typing story.

These steps will help keep the manifest surface uniform and reduce ad-hoc casts as we continue tightening the Postgres DAL.
