# lib.reviews Agent Notes

This repository powers the lib.reviews platform. It includes legacy patterns and is being modernized.

## Guidance for Agents
- Preserve behavior unless explicitly told otherwise; many routes have implicit dependencies.
- If asked for a commit message, use Conventional Commits: subject ≤50 chars, body lines ≤72 chars, ≤4 bullets, describe only the current diff.
- In TypeScript doc comments, omit types in `@param` tags.
- If you touch TS/JS/backend, ensure `npm run lint`, `npm run typecheck`, and `npm run test` pass. `npm run test` may be blocked in restricted sandboxes; ask before running or tell the user to run it locally / with elevation.
- If you touch only CSS/styling, validate with `npm run build:frontend` and skip broader checks unless requested or clearly needed (ask if unsure).
