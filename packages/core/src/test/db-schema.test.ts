import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

import { resolveDbPath, getDb, resetDb } from "../db/schema.js";
import { upsertPosition, getPosition } from "../db/store.js";
import type { StoredPosition } from "../db/store.js";

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

describe("store layer — new fields", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  // Helper to create a minimal StoredPosition stub
  function minimalPosition(
    tokenId: string,
    overrides?: Partial<StoredPosition>,
  ): Omit<StoredPosition, "created_at"> {
    return {
      token_id: tokenId,
      token0: "0x" + "a".repeat(40),
      token1: "0x" + "b".repeat(40),
      token0_symbol: "TKN0",
      token1_symbol: "TKN1",
      token0_decimals: 18,
      token1_decimals: 6,
      fee: 3000,
      tick_lower: -887272,
      tick_upper: 887272,
      entry_sqrt_price_x96: "1461446703485210103287273052203988822378723720",
      entry_block: 100,
      entry_amount0: "1000000000000000000",
      entry_amount1: "1000000",
      entry_liquidity: "1000000000000000000",
      ...overrides,
    };
  }

  it("round-trip: all 7 new fields populated and returned correctly", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "round-trip");
    const tokenId = "9001";

    upsertPosition(
      minimalPosition(tokenId, {
        open_tx: "0xAAAA",
        close_tx: "0xBBBB",
        exit_amount0: "100",
        exit_amount1: "200",
        fees_collected0: "10",
        fees_collected1: "20",
        close_block: 999,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.open_tx).toBe("0xAAAA");
    expect(retrieved?.close_tx).toBe("0xBBBB");
    expect(retrieved?.exit_amount0).toBe("100");
    expect(retrieved?.exit_amount1).toBe("200");
    expect(retrieved?.fees_collected0).toBe("10");
    expect(retrieved?.fees_collected1).toBe("20");
    expect(retrieved?.close_block).toBe(999);
  });

  it("null-by-default: new fields are null when not provided", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "null-by-default");
    const tokenId = "9002";

    upsertPosition(minimalPosition(tokenId));

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.open_tx).toBeNull();
    expect(retrieved?.close_tx).toBeNull();
    expect(retrieved?.exit_amount0).toBeNull();
    expect(retrieved?.exit_amount1).toBeNull();
    expect(retrieved?.fees_collected0).toBeNull();
    expect(retrieved?.fees_collected1).toBeNull();
    expect(retrieved?.close_block).toBeNull();
  });

  it("COALESCE — new data does not overwrite existing close_tx or exit_amount0", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "coalesce");
    const tokenId = "9003";

    // First upsert with close_tx and exit_amount0 set
    upsertPosition(
      minimalPosition(tokenId, {
        close_tx: "0xABC",
        exit_amount0: "500",
      }),
    );

    // Second upsert without providing close_tx or exit_amount0
    // (simulating an entry-only sync)
    upsertPosition(minimalPosition(tokenId));

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    // COALESCE should preserve the old values
    expect(retrieved?.close_tx).toBe("0xABC");
    expect(retrieved?.exit_amount0).toBe("500");
  });

  it("zero-exit sentinel: zero values are distinguishable from null", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "zero-exit");
    const tokenId = "9004";

    upsertPosition(
      minimalPosition(tokenId, {
        exit_amount0: "0",
        exit_amount1: "0",
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    // "0" should be a string zero, not null or undefined
    expect(retrieved?.exit_amount0).toBe("0");
    expect(retrieved?.exit_amount1).toBe("0");
  });

  it("old-row migration: initSchema is idempotent on fresh DB", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "idempotent");
    const db1 = getDb();
    expect(db1).toBeDefined();

    // Call resetDb to clear the cached instance
    resetDb();

    // Call getDb again — this will call initSchema a second time
    const db2 = getDb();
    expect(db2).toBeDefined();

    // Verify that the schema is still intact and working
    const tokenId = "9005";
    upsertPosition(minimalPosition(tokenId));
    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.token_id).toBe(tokenId);
  });
});
