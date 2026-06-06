import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

import { resetDb } from "../db/schema.js";
import { upsertPosition, getPosition } from "../db/store.js";
import type { StoredPosition } from "../db/store.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-db-tests";

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

describe("close_usd_price0 and close_usd_price1 — extreme and invalid values", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  });

  it("1. Zero price — close_usd_price0: 0.0 is stored and read back as 0 (not null, not undefined)", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "zero-price");
    const tokenId = "201";

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: 0.0,
        close_usd_price1: null,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBe(0);
    expect(retrieved?.close_usd_price0).not.toBeNull();
    expect(retrieved?.close_usd_price0).not.toBeUndefined();
    expect(retrieved?.close_usd_price1).toBeNull();
  });

  it("2. Negative price — close_usd_price0: -1.5 is stored and read back as -1.5 (DB layer accepts it; caller's responsibility to validate)", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "negative-price");
    const tokenId = "202";

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: -1.5,
        close_usd_price1: -2.75,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBe(-1.5);
    expect(retrieved?.close_usd_price1).toBe(-2.75);
  });

  it("3. Very large price (BTC-scale, 100_000) — stored and read back without precision loss significant enough to matter for USD display", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "large-btc-scale");
    const tokenId = "203";
    const btcPrice = 100000.0;

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: btcPrice,
        close_usd_price1: btcPrice,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    // For BTC-scale prices, we allow small precision loss (to 2 decimal places for USD display)
    expect(retrieved?.close_usd_price0).toBeCloseTo(btcPrice, 2);
    expect(retrieved?.close_usd_price1).toBeCloseTo(btcPrice, 2);
  });

  it("4. Very small price (near-zero, 0.0000001) — stored and read back correctly as a non-zero float", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "very-small-price");
    const tokenId = "204";
    const verySmallPrice = 0.0000001;

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: verySmallPrice,
        close_usd_price1: verySmallPrice,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    // Very small prices should be retrievable without becoming zero or null
    expect(retrieved?.close_usd_price0).not.toBe(0);
    expect(retrieved?.close_usd_price0).not.toBeNull();
    // Allow for some floating point representation variance
    expect(retrieved?.close_usd_price0).toBeCloseTo(verySmallPrice, 10);
    expect(retrieved?.close_usd_price1).toBeCloseTo(verySmallPrice, 10);
  });

  it("5. Both prices set at max plausible value (999999.99) — both stored and read back correctly", () => {
    process.env.LP_TRACKER_DATA_DIR = join(TMP, "max-plausible");
    const tokenId = "205";
    const maxPrice = 999999.99;

    upsertPosition(
      minimalPosition(tokenId, {
        close_usd_price0: maxPrice,
        close_usd_price1: maxPrice,
      }),
    );

    const retrieved = getPosition(tokenId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.close_usd_price0).toBe(maxPrice);
    expect(retrieved?.close_usd_price1).toBe(maxPrice);
  });
});
