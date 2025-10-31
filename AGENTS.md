# lib.reviews Agent Notes

This repository powers the lib.reviews platform. The codebase dates back several years and still reflects legacy patterns. We are in the middle of a long-running modernization effort.

## Guidance for Agents
- Preserve existing behavior unless instructions say otherwise; many routes have implicit dependencies.
- When asked to draft a commit message, use conventional commit format. Keep the first line ≤50 chars, subsequent lines ≤72 chars, and limit bullet lists to at most four items (but do use bullets to expand on the headline). Only describe changes that remain in the current diff.
