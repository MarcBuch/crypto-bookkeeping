import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { resolveDbPath, getDb, resetDb } from "../db/schema.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-db-tests";

describe("resolveDbPath — env override", () => {
  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
  });

  it("uses LP_TRACKER_DATA_DIR when set", () => {
    process.env.LP_TRACKER_DATA_DIR = "/some/custom/dir";
    const path = resolveDbPath();
    expect(path).toBe("/some/custom/dir/lp-tracker.db");
  });

  it("returns a string ending in lp-tracker.db when env not set", () => {
    delete process.env.LP_TRACKER_DATA_DIR;
    const path = resolveDbPath();
    expect(path.endsWith("lp-tracker.db")).toBe(true);
  });
});

describe("getDb — auto-creates data directory", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("creates the data dir and DB file if they do not exist", () => {
    const dataDir = join(TMP, "new-data-dir");
    expect(existsSync(dataDir)).toBe(false);
    process.env.LP_TRACKER_DATA_DIR = dataDir;

    const db = getDb();
    expect(db).toBeDefined();
    expect(existsSync(join(dataDir, "lp-tracker.db"))).toBe(true);
  });

  it("returns the same DB instance on repeated calls (singleton)", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "singleton-test");
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it("creates the positions and snapshots tables", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "schema-test");
    const db = getDb();
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("positions");
    expect(names).toContain("snapshots");
  });

  it("includes entry_liquidity column after migration", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "migration-test");
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(positions)").all() as {
      name: string;
    }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("entry_liquidity");
  });

  it("resetDb() allows a fresh DB to be opened on next getDb() call", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "reset-test");
    const db1 = getDb();
    resetDb();
    const db2 = getDb();
    // After reset, a new instance is returned
    expect(db2).not.toBe(db1);
  });
});

describe("getDb — nested directory creation", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("creates deeply nested data directory automatically", () => {
    const deep = join(TMP, "a", "b", "c", "data");
    process.env.LP_TRACKER_DATA_DIR = deep;
    const db = getDb();
    expect(db).toBeDefined();
    expect(existsSync(join(deep, "lp-tracker.db"))).toBe(true);
  });
});
