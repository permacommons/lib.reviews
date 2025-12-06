# lib.reviews Agent Notes

This repository powers the lib.reviews platform. It includes legacy patterns and is being modernized.

## Tech Stack
- Runtime/language: Node.js (>=22), TypeScript (ESM)
- Backend: Express, Handlebars (`hbs`), `config`
- Data/search: PostgreSQL (`pg`), sessions (`connect-pg-simple`), Elasticsearch client
- Frontend: Vite (MPA) + TS modules, PicoCSS, jQuery, ProseMirror, PostCSS
- Tooling: Biome (lint/format), AVA (+ Supertest/Nock/JSdom), TypeDoc

## Guidance for Agents
- Preserve behavior unless explicitly told otherwise; many routes have implicit dependencies.
- Code comments should describe the code that is there, not legacy behavior or intermediate steps.
- Code comments are NOT a tool to support user-agent communication; they must only be added if they have long-term value.
- If asked for a commit message, use Conventional Commits: subject ≤50 chars, body lines ≤72 chars, ≤4 bullets, describe only the current diff.
- In TypeScript doc comments, omit types in `@param` tags.
- If you touch TS/JS/backend, ensure `npm run lint`, `npm run typecheck`, and `npm run test` pass. `npm run test` may be blocked in restricted sandboxes; ask before running or tell the user to run it locally / with elevation.
- During CSS-only iteration, you can usually rely on Vite HMR/dev server for feedback; run `npm run build:frontend` when changing PostCSS features (nesting/mixins), when the user reports Vite errors, or when anything about the CSS pipeline/bundling changes.
