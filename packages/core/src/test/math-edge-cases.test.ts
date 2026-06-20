/**
 * m2t3 — Adversarial tests: P&L / IL math edge cases
 *
 * Tests pure math functions directly from packages/core/src/math/divergence-loss.ts.
 * No network calls; no DB access.
 */

import { describe, it, expect } from "bun:test";

import {
  calculateDivergenceLoss,
  sqrtPriceX96ToPrice,
  getTokenAmounts,
  calculateFullPnL,
  calculateUnclaimedFees,
  tickToSqrtPrice,
  tickToPrice,
  type FullPnLResult,
} from "../math/divergence-loss.js";

// Useful constants
const Q96 = 2n ** 96n;

// A realistic sqrtPriceX96 for price ≈ 1.0 (18-decimal / 18-decimal pair)
const SQRT_PRICE_1_0 = Q96; // sqrtPrice = 1.0 → price = 1.0

// A realistic sqrtPriceX96 for price ≈ 2.0
const SQRT_PRICE_2_0 = BigInt(Math.floor(Math.sqrt(2) * Number(Q96)));

// Valid tick range for an in-range position
const TICK_LOWER = -100;
const TICK_UPPER = 100;

// A realistic liquidity value
const LIQUIDITY = 1_000_000_000n;

type FullPnlNumericField = {
  [K in keyof FullPnLResult]: FullPnLResult[K] extends number ? K : never;
}[keyof FullPnLResult];

// ───────────────────────────────────────────────────────────────────────────
// 1. calculateDivergenceLoss — holdValue = 0 → divergenceLoss = 0, not NaN
// ───────────────────────────────────────────────────────────────────────────

describe("calculateDivergenceLoss — holdValue = 0 edge case", () => {
  it("returns divergenceLoss = 0 (not NaN/Infinity) when entry amounts produce valueHold = 0", () => {
    // Force valueHold = 0: set both entry amounts to 0 by using 0 liquidity.
    // With liquidity = 0, all getTokenAmounts calls return {amount0: 0n, amount1: 0n}.
    const result = calculateDivergenceLoss(
      0n, // liquidity = 0 → both entry & current amounts are 0
      TICK_LOWER,
      TICK_UPPER,
      SQRT_PRICE_1_0,
      SQRT_PRICE_2_0,
      18,
      18,
    );

    expect(result.divergenceLoss).toBe(0);
    expect(isNaN(result.divergenceLoss)).toBe(false);
    expect(isFinite(result.divergenceLoss)).toBe(true);
  });

  it("divergenceLossPercent string is parseable even with 0 liquidity", () => {
    const result = calculateDivergenceLoss(
      0n,
      TICK_LOWER,
      TICK_UPPER,
      SQRT_PRICE_1_0,
      SQRT_PRICE_2_0,
      18,
      18,
    );
    const pct = parseFloat(result.divergenceLossPercent);
    expect(isNaN(pct)).toBe(false);
    expect(isFinite(pct)).toBe(true);
  });

  it("valueHold guard: formula (valueLp - valueHold) / valueHold is not evaluated when valueHold = 0", () => {
    // Direct code path: when valueHold = 0 the guard returns 0, not a division
    const result = calculateDivergenceLoss(
      0n,
      TICK_LOWER,
      TICK_UPPER,
      SQRT_PRICE_1_0,
      SQRT_PRICE_1_0,
      18,
      18,
    );
    expect(result.divergenceLoss).not.toBeNaN();
    expect(result.divergenceLoss).not.toBe(Infinity);
    expect(result.divergenceLoss).not.toBe(-Infinity);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. sqrtPriceX96ToPrice — zero input
// ───────────────────────────────────────────────────────────────────────────

describe("sqrtPriceX96ToPrice — zero and boundary inputs", () => {
  it("does not throw when sqrtPriceX96 = 0n", () => {
    expect(() => sqrtPriceX96ToPrice(0n, 18, 18)).not.toThrow();
  });

  it("returns 0 when sqrtPriceX96 = 0n", () => {
    const price = sqrtPriceX96ToPrice(0n, 18, 18);
    expect(price).toBe(0);
  });

  it("handles equal decimals without decimal adjustment error", () => {
    const price = sqrtPriceX96ToPrice(SQRT_PRICE_1_0, 6, 6);
    expect(price).toBeGreaterThan(0);
    expect(isFinite(price)).toBe(true);
  });

  it("handles decimals0 > decimals1 (e.g. 18/6 like WETH/USDC)", () => {
    const price = sqrtPriceX96ToPrice(SQRT_PRICE_1_0, 18, 6);
    expect(isFinite(price)).toBe(true);
    expect(price).not.toBeNaN();
  });

  it("handles decimals0 < decimals1 (reversed pair)", () => {
    const price = sqrtPriceX96ToPrice(SQRT_PRICE_1_0, 6, 18);
    expect(isFinite(price)).toBe(true);
    expect(price).not.toBeNaN();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. getTokenAmounts — 0 liquidity
// ───────────────────────────────────────────────────────────────────────────

describe("getTokenAmounts — 0 liquidity", () => {
  it("returns {amount0: 0n, amount1: 0n} with liquidity = 0n (price within range)", () => {
    const result = getTokenAmounts(0n, SQRT_PRICE_1_0, TICK_LOWER, TICK_UPPER);
    expect(result.amount0).toBe(0n);
    expect(result.amount1).toBe(0n);
  });

  it("returns {amount0: 0n, amount1: 0n} with liquidity = 0n (price below range)", () => {
    const sqrtPriceBelowRange = BigInt(Math.floor(0.5 * Number(Q96)));
    const result = getTokenAmounts(0n, sqrtPriceBelowRange, TICK_LOWER, TICK_UPPER);
    expect(result.amount0).toBe(0n);
    expect(result.amount1).toBe(0n);
  });

  it("returns {amount0: 0n, amount1: 0n} with liquidity = 0n (price above range)", () => {
    const sqrtPriceAboveRange = BigInt(Math.floor(100 * Number(Q96)));
    const result = getTokenAmounts(0n, sqrtPriceAboveRange, TICK_LOWER, TICK_UPPER);
    expect(result.amount0).toBe(0n);
    expect(result.amount1).toBe(0n);
  });

  it("returns bigint types for both amounts", () => {
    const result = getTokenAmounts(0n, SQRT_PRICE_1_0, TICK_LOWER, TICK_UPPER);
    expect(typeof result.amount0).toBe("bigint");
    expect(typeof result.amount1).toBe("bigint");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. tickToPrice / tickToSqrtPrice — extreme tick values
// ───────────────────────────────────────────────────────────────────────────

describe("tickToSqrtPrice / tickToPrice — extreme tick values", () => {
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;

  it("tickToSqrtPrice does not throw at MIN_TICK", () => {
    expect(() => tickToSqrtPrice(MIN_TICK)).not.toThrow();
  });

  it("tickToSqrtPrice does not throw at MAX_TICK", () => {
    expect(() => tickToSqrtPrice(MAX_TICK)).not.toThrow();
  });

  it("tickToSqrtPrice at MAX_TICK returns a finite number", () => {
    const v = tickToSqrtPrice(MAX_TICK);
    expect(isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it("tickToSqrtPrice at MIN_TICK returns a positive finite number", () => {
    const v = tickToSqrtPrice(MIN_TICK);
    expect(isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  });

  it("tickToPrice does not throw at MIN_TICK", () => {
    expect(() => tickToPrice(MIN_TICK)).not.toThrow();
  });

  it("tickToPrice does not throw at MAX_TICK", () => {
    expect(() => tickToPrice(MAX_TICK)).not.toThrow();
  });

  it("tickToPrice at MAX_TICK is a very large finite number", () => {
    const v = tickToPrice(MAX_TICK);
    expect(isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1);
  });

  it("tickToPrice at MIN_TICK is a very small positive number", () => {
    const v = tickToPrice(MIN_TICK);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("getTokenAmounts does not throw at extreme tick values", () => {
    expect(() => getTokenAmounts(LIQUIDITY, SQRT_PRICE_1_0, MIN_TICK, MAX_TICK)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. calculateFullPnL — equal entry/exit prices
// ───────────────────────────────────────────────────────────────────────────

describe("calculateFullPnL — equal entry/exit prices", () => {
  // Strategy: derive entry/exit amounts from actual V3 math at a fixed price
  // so that deriveEntryPriceFromAmounts() recovers the same price.
  // This ensures entryPrice ≈ exitPrice and divergenceLoss = 0.
  //
  // Use 18/18 decimals for simplicity; sqrtPriceX96 = Q96 → price = 1.0.

  const dec0 = 18;
  const dec1 = 18;

  // Price = 1.0 → sqrtPriceX96 = Q96
  const exitSqrtPriceX96 = Q96;

  // Wide-enough ticks that the price (= 1.0) is within range
  const tickLower = -100;
  const tickUpper = 100;

  // Large liquidity so amounts are non-trivially large
  const liq = 1_000_000_000_000_000n;

  // Get actual token amounts that V3 would produce at this price/liquidity/range
  const amounts = getTokenAmounts(liq, exitSqrtPriceX96, tickLower, tickUpper);
  const entryAmount0Raw = amounts.amount0;
  const entryAmount1Raw = amounts.amount1;
  const exitAmount0Raw = amounts.amount0;
  const exitAmount1Raw = amounts.amount1;

  // Fees: 0.001 token0 and 0.0005 token1 in raw units
  const feesCollected0Raw = 1_000_000_000_000n;
  const feesCollected1Raw = 500_000_000_000n;

  it("divergenceLoss = 0 when entry amounts match exit amounts at same price", () => {
    const result = calculateFullPnL({
      entryAmount0Raw,
      entryAmount1Raw,
      exitAmount0Raw,
      exitAmount1Raw,
      feesCollected0Raw,
      feesCollected1Raw,
      exitSqrtPriceX96,
      tickLower,
      tickUpper,
      liquidity: liq,
      decimals0: dec0,
      decimals1: dec1,
    });

    expect(result.divergenceLoss).toBe(0);
  });

  it("absolutePnl ≈ feesValue when position value is unchanged", () => {
    const result = calculateFullPnL({
      entryAmount0Raw,
      entryAmount1Raw,
      exitAmount0Raw,
      exitAmount1Raw,
      feesCollected0Raw,
      feesCollected1Raw,
      exitSqrtPriceX96,
      tickLower,
      tickUpper,
      liquidity: liq,
      decimals0: dec0,
      decimals1: dec1,
    });

    // absolutePnl = exitValue + feesValue - entryValue
    // Since exitValue ≈ entryValue (same amounts, derived price ≈ exit price),
    // absolutePnl ≈ feesValue (within floating-point tolerance).
    expect(Math.abs(result.absolutePnl - result.feesValue)).toBeLessThan(1e-9);
  });

  it("opportunityCost ≈ 0 when exit == HODL (no price change)", () => {
    // When prices and amounts don't change, HODL value = LP value
    const result = calculateFullPnL({
      entryAmount0Raw,
      entryAmount1Raw,
      exitAmount0Raw,
      exitAmount1Raw,
      feesCollected0Raw,
      feesCollected1Raw,
      exitSqrtPriceX96,
      tickLower,
      tickUpper,
      liquidity: liq,
      decimals0: dec0,
      decimals1: dec1,
    });

    expect(Math.abs(result.opportunityCost)).toBeLessThan(1e-9);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6. calculateFullPnL — all-zero raw amounts
// ───────────────────────────────────────────────────────────────────────────

describe("calculateFullPnL — all-zero raw amounts", () => {
  it("does not throw with all-zero amounts", () => {
    expect(() =>
      calculateFullPnL({
        entryAmount0Raw: 0n,
        entryAmount1Raw: 0n,
        exitAmount0Raw: 0n,
        exitAmount1Raw: 0n,
        feesCollected0Raw: 0n,
        feesCollected1Raw: 0n,
        exitSqrtPriceX96: SQRT_PRICE_1_0,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        liquidity: 1n,
        decimals0: 18,
        decimals1: 18,
      }),
    ).not.toThrow();
  });

  it("absolutePnl = 0 when all amounts are zero", () => {
    const result = calculateFullPnL({
      entryAmount0Raw: 0n,
      entryAmount1Raw: 0n,
      exitAmount0Raw: 0n,
      exitAmount1Raw: 0n,
      feesCollected0Raw: 0n,
      feesCollected1Raw: 0n,
      exitSqrtPriceX96: SQRT_PRICE_1_0,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: 1n,
      decimals0: 18,
      decimals1: 18,
    });

    expect(result.absolutePnl).toBe(0);
  });

  it("divergenceLoss = 0 (not NaN) when all amounts are zero", () => {
    const result = calculateFullPnL({
      entryAmount0Raw: 0n,
      entryAmount1Raw: 0n,
      exitAmount0Raw: 0n,
      exitAmount1Raw: 0n,
      feesCollected0Raw: 0n,
      feesCollected1Raw: 0n,
      exitSqrtPriceX96: SQRT_PRICE_1_0,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: 1n,
      decimals0: 18,
      decimals1: 18,
    });

    expect(result.divergenceLoss).toBe(0);
    expect(isNaN(result.divergenceLoss)).toBe(false);
  });

  it("returns numeric (not NaN) values for all fields when amounts are zero", () => {
    const result = calculateFullPnL({
      entryAmount0Raw: 0n,
      entryAmount1Raw: 0n,
      exitAmount0Raw: 0n,
      exitAmount1Raw: 0n,
      feesCollected0Raw: 0n,
      feesCollected1Raw: 0n,
      exitSqrtPriceX96: SQRT_PRICE_1_0,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: 1n,
      decimals0: 18,
      decimals1: 18,
    });

    const numericFields: FullPnlNumericField[] = [
      "entryAmount0",
      "entryAmount1",
      "exitAmount0",
      "exitAmount1",
      "entryPrice",
      "exitPrice",
      "entryValue",
      "exitValue",
      "holdValue",
      "feesCollected0",
      "feesCollected1",
      "feesValue",
      "absolutePnl",
      "absolutePnlPercent",
      "divergenceLoss",
      "opportunityCost",
      "netVsHodl",
      "priceLower",
      "priceUpper",
    ];

    for (const field of numericFields) {
      const v = result[field];
      expect(typeof v).toBe("number");
      expect(isNaN(v)).toBe(false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. calculateUnclaimedFees — 0 liquidity
// ───────────────────────────────────────────────────────────────────────────

describe("calculateUnclaimedFees — 0 liquidity", () => {
  it("returns {fees0: 0, fees1: 0} when liquidity = 0n and no tokens owed", () => {
    const result = calculateUnclaimedFees(
      0n, // liquidity
      0n, // feeGrowthInside0LastX128
      0n, // feeGrowthInside1LastX128
      0n, // feeGrowthInside0CurrentX128
      0n, // feeGrowthInside1CurrentX128
      0n, // tokensOwed0
      0n, // tokensOwed1
      18, // decimals0
      18, // decimals1
    );

    expect(result.fees0).toBe(0);
    expect(result.fees1).toBe(0);
  });

  it("returns only tokensOwed when liquidity = 0 but tokensOwed > 0", () => {
    // tokensOwed = 1e18 raw units = 1.0 token
    const tokensOwed = BigInt(1e18);
    const result = calculateUnclaimedFees(0n, 0n, 0n, 0n, 0n, tokensOwed, 0n, 18, 18);

    expect(result.fees0).toBeCloseTo(1.0, 5);
    expect(result.fees1).toBe(0);
  });

  it("handles fee growth wrap-around (underflow path) without throwing", () => {
    // Simulate a wrap: currentX128 < lastX128
    const last = 2n ** 200n;
    const current = 100n; // << last → triggers underflow branch

    expect(() =>
      calculateUnclaimedFees(LIQUIDITY, last, last, current, current, 0n, 0n, 18, 18),
    ).not.toThrow();
  });

  it("fees are non-negative for all inputs", () => {
    const result = calculateUnclaimedFees(LIQUIDITY, 0n, 0n, 1000n, 2000n, 10n, 20n, 18, 6);

    expect(result.fees0).toBeGreaterThanOrEqual(0);
    expect(result.fees1).toBeGreaterThanOrEqual(0);
  });
});
