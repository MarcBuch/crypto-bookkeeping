# Agent Notes

Gotchas and lessons learned for AI agents working in this repo.

---

Always delegate codebase exploration (directory structure, package layout, understanding dependencies, finding files/routes) to the codebase-explorer subagent by using `task` with `subagent_type: "codebase-explorer"`.

## Testing

### `bun test` vs `bun run test` — critical difference

Running `bun test` from the repo root runs all test files in a shared process **without** module isolation. Running `bun run test` from `packages/core` uses `bun test --isolate src/test`, which gives each file its own module registry. Without `--isolate`:

- `mock.module()` calls at the top level of one test file leak into every subsequent test file in the same process
- e.g. `pnl.test.ts` mocking `../services/pricing.js` caused all `pricing.test.ts` tests to fail when run together

**Always verify with `bun run test` from `packages/core`, not `bun test` from the root.**
