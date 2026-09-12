#!/usr/bin/env bun
/**
 * Process-per-file test runner for packages/core.
 *
 * WHY this exists instead of a single `bun test --isolate src/test`:
 * bun runs test files concurrently in one process. `--isolate` gives each file
 * its own module registry, but it does NOT isolate `process.env`. The shared
 * test helper `src/test/helpers/db.ts` (useTestDb) routes the SQLite DB via
 * `process.env.LP_TRACKER_DATA_DIR` in beforeEach/afterEach hooks, so files
 * running concurrently clobber each other's env var and DB singleton, causing
 * mass cross-file failures. Running each file in its own OS process is the only
 * reliable way to run this suite. Please do not "simplify" this back.
 *
 * Usage: bun run scripts/run-tests.ts [glob]
 *   glob defaults to "**\/*.test.ts" (relative to src/test)
 */
import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");
const testDir = join(packageRoot, "src", "test");
const pattern = process.argv[2] ?? "**/*.test.ts";

const files = [...new Bun.Glob(pattern).scanSync({ cwd: testDir, onlyFiles: true })].sort();

if (files.length === 0) {
  console.error(`No test files found matching "${pattern}" in ${testDir}`);
  process.exit(1);
}

const startedAt = Date.now();
let passedFiles = 0;
let failedFiles = 0;
let totalPass = 0;
let totalFail = 0;

for (const file of files) {
  const proc = Bun.spawn([process.execPath, "test", "--isolate", `./src/test/${file}`], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout + stderr;

  const pass = Number(output.match(/^\s*(\d+) pass\b/m)?.[1] ?? 0);
  const fail = Number(output.match(/^\s*(\d+) fail\b/m)?.[1] ?? 0);
  totalPass += pass;
  totalFail += fail;

  if (exitCode === 0) {
    passedFiles++;
    console.log(`ok   src/test/${file} (${pass} pass, ${fail} fail)`);
  } else {
    failedFiles++;
    console.error(`\nFAIL src/test/${file}\n`);
    console.error(output.trimEnd());
    console.error("");
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `${files.length} files: ${passedFiles} ok, ${failedFiles} failed ` +
    `(${totalPass} pass / ${totalFail} fail tests) in ${seconds}s`,
);

process.exit(failedFiles > 0 ? 1 : 0);
