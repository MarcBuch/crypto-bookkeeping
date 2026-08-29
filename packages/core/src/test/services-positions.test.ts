/**
 * m2t2 — Adversarial tests: position service layer (DB-only paths)
 *
 * Exercises getHistoryView, which only touches the SQLite layer.
 */

import { describe, it, expect } from "bun:test";

import { upsertPosition, insertSnapshot } from "../db/store.js";
import { NotFoundError } from "../services/errors.js";
import { getHistoryView } from "../services/history.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePosition(tokenId: string) {
  upsertPosition({
    token_id: tokenId,
    token0: "0x0000000000000000000000000000000000000001",
    token1: "0x0000000000000000000000000000000000000002",
    token0_symbol: "WBTC",
    token1_symbol: "USDC",
    token0_decimals: 8,
    token1_decimals: 6,
    fee: 3000,
    tick_lower: -60,
    tick_upper: 60,
    entry_sqrt_price_x96: "7922816251426433759354395033n",
    entry_block: 1000,
    entry_amount0: "100000000",
    entry_amount1: "3000000000",
    entry_liquidity: "500000000000",
  });
}

function makeSnapshot(tokenId: string, offsetSec = 0) {
  // Use a non-zero sqrtPriceX96 so the price math doesn't blow up
  const sqrtPriceX96 = "79228162514264337593543950336"; // 1.0 price at 1:1 decimals
  insertSnapshot({
    token_id: tokenId,
    timestamp: new Date(Date.now() - offsetSec * 1000).toISOString(),
    liquidity: "500000000000",
    current_sqrt_price_x96: sqrtPriceX96,
    current_tick: 0,
    current_amount0: "0.5",
    current_amount1: "1500",
    entry_amount0: "1.0",
    entry_amount1: "3000",
    value_lp: 4500,
    value_hold: 5000,
    divergence_loss: -0.01,
    fees0: 0.001,
    fees1: 0.5,
    fees_value: 3.5,
    net_pnl: -46.5,
  });
}

function expectNotFoundError(error: unknown): NotFoundError {
  expect(error).toBeInstanceOf(NotFoundError);
  if (!(error instanceof NotFoundError)) {
    throw new Error(`Expected NotFoundError, got ${String(error)}`);
  }
  return error;
}

// ---------------------------------------------------------------------------
// getHistoryView with no stored position → NotFoundError
// ---------------------------------------------------------------------------

describe("getHistoryView — no stored position", () => {
  useTestDb();

  it("throws NotFoundError when tokenId has no stored position", async () => {
    try {
      await getHistoryView("999999", 10);
      throw new Error("Expected getHistoryView to reject");
    } catch (error) {
      expectNotFoundError(error);
    }
  });

  it("error message references the tokenId", async () => {
    try {
      await getHistoryView("999999", 10);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      const error = expectNotFoundError(err);
      expect(error.message).toContain("999999");
    }
  });
});

// ---------------------------------------------------------------------------
// getHistoryView with stored position but no snapshots → NotFoundError
// ---------------------------------------------------------------------------

describe("getHistoryView — position exists but no snapshots", () => {
  useTestDb();

  it("throws NotFoundError when position exists but has no snapshots", async () => {
    makePosition("42");
    try {
      await getHistoryView("42", 10);
      throw new Error("Expected getHistoryView to reject");
    } catch (error) {
      expectNotFoundError(error);
    }
  });

  it("NotFoundError message mentions 'snapshot'", async () => {
    makePosition("42");
    try {
      await getHistoryView("42", 10);
      expect(true).toBe(false);
    } catch (err) {
      const error = expectNotFoundError(err);
      expect(error.message.toLowerCase()).toContain("snapshot");
    }
  });
});

// ---------------------------------------------------------------------------
// Position with snapshots returns data correctly
// ---------------------------------------------------------------------------

describe("getHistoryView — position with snapshots returns results", () => {
  useTestDb();

  it("returns an array when snapshots exist", async () => {
    makePosition("7");
    makeSnapshot("7", 0);
    makeSnapshot("7", 3600);

    const result = await getHistoryView("7", 10);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
  });

  it("each result item has expected fields", async () => {
    makePosition("7");
    makeSnapshot("7");

    const [item] = await getHistoryView("7", 10);
    expect(item.tokenId).toBe("7");
    expect(item.pair).toBe("WBTC/USDC");
    expect(typeof item.currentPrice).toBe("number");
    expect(typeof item.divergenceLossPercent).toBe("number");
    expect(typeof item.feesValue).toBe("number");
    expect(typeof item.netPnl).toBe("number");
    expect(typeof item.valueLp).toBe("number");
    expect(typeof item.valueHold).toBe("number");
  });

  it("respects the limit parameter", async () => {
    makePosition("8");
    // Insert 5 snapshots
    for (let i = 0; i < 5; i++) {
      makeSnapshot("8", i * 60);
    }

    const result = await getHistoryView("8", 3);
    expect(result.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getHistoryView limit behavior
// ---------------------------------------------------------------------------

describe("getHistoryView — limit behavior", () => {
  useTestDb();

  it("limit = 0: SQLite returns 0 rows — service throws NotFoundError (no snapshots path)", async () => {
    // SQLite LIMIT 0 returns zero rows. Even if we insert snapshots, getSnapshots()
    // returns [], which triggers the "no snapshots" NotFoundError branch.
    makePosition("10");
    makeSnapshot("10");

    // The service delegates limit directly to getSnapshots, which passes it to SQL.
    // LIMIT 0 in SQLite returns empty result — service treats it as no snapshots.
    try {
      await getHistoryView("10", 0);
      throw new Error("Expected getHistoryView to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
    }
  });

  it("default limit (undefined) returns up to 20 most recent snapshots", async () => {
    makePosition("12");
    for (let i = 0; i < 25; i++) {
      makeSnapshot("12", i * 10);
    }

    const result = await getHistoryView("12");
    // Default limit in history.ts is 20 (falls through to getSnapshots(tokenId, 20))
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result.length).toBeGreaterThan(0);
  });
});
