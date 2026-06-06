import { beforeEach, afterEach } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resetDb } from "../../db/schema.js";

/**
 * Test helper that sets up an isolated temporary database for each test.
 *
 * Registers beforeEach and afterEach hooks that:
 * - Create a unique temp directory per test
 * - Set LP_TRACKER_DATA_DIR to that directory
 * - Reset the DB singleton before and after the test
 * - Clean up the temp directory after the test
 *
 * Usage:
 *   import { useTestDb } from "./helpers/db.js";
 *
 *   describe("My tests", () => {
 *     useTestDb();
 *
 *     it("uses an isolated DB", () => {
 *       const db = getDb();
 *       // test code...
 *     });
 *   });
 */
export function useTestDb(): void {
  let dir = "";

  beforeEach(() => {
    // Create a unique temp directory for this test
    dir = join(tmpdir(), "lp-tracker-test-" + randomUUID());

    // Ensure the directory exists before setting the env var
    mkdirSync(dir, { recursive: true });

    // Set the env var so getDb() uses this directory
    process.env.LP_TRACKER_DATA_DIR = dir;

    // Reset any existing DB singleton
    resetDb();
  });

  afterEach(() => {
    // Delete the env var
    delete process.env.LP_TRACKER_DATA_DIR;

    // Reset the DB singleton
    resetDb();

    // Clean up the temp directory if it exists
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });
}
