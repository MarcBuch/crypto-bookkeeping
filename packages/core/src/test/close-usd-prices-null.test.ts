import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

import { resetDb } from "../db/schema.js";
import { upsertPosition, getPosition } from "../db/store.js";
import type { StoredPosition } from "../db/store.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-db-tests";

describe("close_usd_price0 and close_usd_price1 — null handling and COALESCE", () => {
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

  it("1. Both null on insert — upsertPosition with close_usd_price0: null, close_usd_price1: null stores nulls", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "both-null-insert");
    const tokenId = "101";

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: null,
        close_usd_price1: null,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBeNull();
    expect(retrieved?.close_usd_price1).toBeNull();
  });

  it("2. One null, one valid — upsertPosition with close_usd_price0: 1.23, close_usd_price1: null; read back confirms price0 stored, price1 is null", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "one-null-one-valid");
    const tokenId = "102";

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 1.23,
        close_usd_price1: null,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBe(1.23);
    expect(retrieved?.close_usd_price1).toBeNull();
  });

  it("3. COALESCE: re-upsert with null does NOT overwrite existing non-null", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "coalesce-no-overwrite");
    const tokenId = "103";

    // First upsert with close_usd_price0: 42.5
    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 42.5,
        close_usd_price1: null,
      }),
    );

    let retrieved = getPosition(tokenId);
    expect(retrieved?.close_usd_price0).toBe(42.5);

    // Second upsert with close_usd_price0: null (should NOT overwrite)
    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: null,
        close_usd_price1: 55.0,
      }),
    );

    retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    // COALESCE should preserve the old close_usd_price0 value
    expect(retrieved?.close_usd_price0).toBe(42.5);
    // But close_usd_price1 should be updated
    expect(retrieved?.close_usd_price1).toBe(55.0);
  });

  it("4. COALESCE: re-upsert with a new non-null value DOES overwrite", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "coalesce-overwrite");
    const tokenId = "104";

    // First upsert with close_usd_price0: 42.5
    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 42.5,
        close_usd_price1: 10.0,
      }),
    );

    let retrieved = getPosition(tokenId);
    expect(retrieved?.close_usd_price0).toBe(42.5);
    expect(retrieved?.close_usd_price1).toBe(10.0);

    // Second upsert with close_usd_price0: 99.9 (should overwrite)
    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 99.9,
        close_usd_price1: 15.0,
      }),
    );

    retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBe(99.9);
    expect(retrieved?.close_usd_price1).toBe(15.0);
  });

  it("5. getPosition() read-back type — confirm returned field is number | null, not string", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "type-check");
    const tokenId = "105";

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 123.456,
        close_usd_price1: null,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();

    // Verify close_usd_price0 is a number, not a string
    expect(typeof retrieved?.close_usd_price0).toBe("number");
    expect(retrieved?.close_usd_price0).toBe(123.456);

    // Verify close_usd_price1 is null
    expect(retrieved?.close_usd_price1).toBeNull();
  });
});
