# lib.reviews Agent Notes

This repository powers the lib.reviews platform. The codebase dates back several years and still reflects legacy patterns (Express 4, Grunt/Browserify asset pipeline, Thinky/RethinkDB). We are in the middle of a long-running modernization effort.

## Current Focus
- Target runtime: Node.js 22.x (update dependencies, code, and tooling with this version in mind).
- Progressive refactors: favor incremental improvements over big bangs; prefer adding tests when touching fragile areas.
- Asset/build pipeline: slated for replacement, but Grunt/Browserify remain the source of truth until a new toolchain is ready.
- Database: still Thinky + RethinkDB; evaluate migration paths carefully before making breaking changes.

## Guidance for Agents
- Preserve existing behavior unless instructions say otherwise; many routes have implicit dependencies.
- Document notable trade-offs or open questions in PR descriptions or this file to keep future contributors aligned.
- When in doubt about a legacy pattern, surface findings before refactoring; the maintainers value visibility over surprises.
