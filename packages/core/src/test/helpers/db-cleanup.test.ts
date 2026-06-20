import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";

import { getDb } from "../../db/schema.js";
import { useTestDb } from "./db.js";

function countPositions(db: ReturnType<typeof getDb>): number {
  const row = db.prepare<{ cnt: number }, []>(`SELECT COUNT(*) as cnt FROM positions`).get();
  if (!row) {
    throw new Error("Expected COUNT(*) query to return a row");
  }
  return row.cnt;
}

describe("cleanup contracts", () => {
  useTestDb();

  let dirFromTest1 = "";
  let dirFromTest2 = "";
  let dbFromTest1: ReturnType<typeof getDb> | null = null;

  it("test 1: env var is set, dir exists, db is created", () => {
    // Capture the env var and directory
    dirFromTest1 = process.env.LP_TRACKER_DATA_DIR ?? "";
    expect(dirFromTest1).not.toBe("");

    // Directory should exist
    expect(existsSync(dirFromTest1)).toBe(true);

    // Create a DB and insert test data
    const db = getDb();
    dbFromTest1 = db;
    expect(db).toBeTruthy();

    // Insert a position to verify data persistence
    db.prepare(
      `INSERT INTO positions (token_id, token0, token1, fee, tick_lower, tick_upper)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("test-pos-1", "0xaaa", "0xbbb", 3000, -100, 100);

    // Verify the data is in the DB
    expect(countPositions(db)).toBe(1);
  });

  it("test 2: after test 1, old dir is gone, env var is different, db is fresh", () => {
    expect(dirFromTest1).not.toBe(""); // guard: test 1 must have run

    const currentDir = process.env.LP_TRACKER_DATA_DIR ?? "";
    dirFromTest2 = currentDir; // capture test 2's dir

    // New env var is set (not empty)
    expect(currentDir).not.toBe("");

    // New env var is DIFFERENT from test 1's dir
    expect(currentDir).not.toBe(dirFromTest1);

    // Old dir from test 1 no longer exists
    expect(existsSync(dirFromTest1)).toBe(false);

    // Get a new DB instance
    const db = getDb();

    // New DB should be a different object than test 1's DB
    expect(db).not.toBe(dbFromTest1);

    // New DB should be empty (no positions from test 1)
    expect(countPositions(db)).toBe(0);
  });

  it("test 3: singleton is reset for another cycle", () => {
    expect(dirFromTest2).not.toBe(""); // guard: test 2 must have run

    const test3Dir = process.env.LP_TRACKER_DATA_DIR ?? "";

    // Should be different from test 2's dir
    expect(test3Dir).not.toBe("");
    expect(test3Dir).not.toBe(dirFromTest2);

    // Old dir from test 2 no longer exists
    expect(existsSync(dirFromTest2)).toBe(false);

    // DB should be empty again
    const db = getDb();
    expect(countPositions(db)).toBe(0);
  });
});
