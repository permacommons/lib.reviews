# lib.reviews Agent Notes

This repository powers the lib.reviews platform. The codebase dates back several years and still reflects legacy patterns (Express 4, Grunt/Browserify asset pipeline, Thinky/RethinkDB). We are in the middle of a long-running modernization effort.

## Current Focus
- Target runtime: Node.js 22.x (update dependencies, code, and tooling with this version in mind).
- Progressive refactors: favor incremental improvements over big bangs; prefer adding tests when touching fragile areas.
- Asset/build pipeline: slated for replacement, but Grunt/Browserify remain the source of truth until a new toolchain is ready.
- Database: still Thinky + RethinkDB; evaluate migration paths carefully before making breaking changes.
- Modernization roadmap (dependency upgrades, testing quirks, external service notes) lives in `plans/modernization-roadmap.md`.

## Guidance for Agents
- Preserve existing behavior unless instructions say otherwise; many routes have implicit dependencies.
- Document notable trade-offs or open questions in PR descriptions or this file to keep future contributors aligned.
- When in doubt about a legacy pattern, surface findings before refactoring; the maintainers value visibility over surprises.
- When asked to draft a commit message, use conventional commit format. Keep the first line ≤50 chars, subsequent lines ≤72 chars, and limit bullet lists to at most four items. Only describe changes that remain in the current diff.
- Run the test suite outside the sandbox environment; local sandbox networking blocks RethinkDB and Elasticsearch, leading to cascading failures.
