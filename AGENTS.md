# Agent Notes

Gotchas and lessons learned for AI agents working in this repo.

---

Always delegate codebase exploration (directory structure, package layout, understanding dependencies, finding files/routes) to the `codebase-explorer` subagent using the `subagent` tool.

If you run into SSL issues, use the ca.pem cert file.

## Testing

### `bun test` vs `bun run test` — critical difference

bun runs test files **concurrently in one process**. `bun test --isolate` isolates each file's module registry, but it does **not** isolate `process.env`. The shared test helper `useTestDb` (in `packages/core/src/test/helpers/db.ts`) routes the SQLite DB via `process.env.LP_TRACKER_DATA_DIR`, so concurrently-running files clobber each other's env var and DB singleton, causing mass cross-file failures (and top-level `mock.module()` calls leak between files too).

`bun run test` from `packages/core` now runs **each test file in its own OS process** via `scripts/run-tests.ts`. This is the only reliable way to run the core suite.

**Always verify with `bun run test` from `packages/core`. Never use bare `bun test` from the repo root** — that runs all packages' files concurrently in one process, with the same env-var bleed plus cross-package interference.

`bun run test` in `apps/api` and `apps/web` remains fine as-is.
