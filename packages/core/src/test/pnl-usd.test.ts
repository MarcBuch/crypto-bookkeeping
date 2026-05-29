import { describe, expect, it } from "bun:test";
import { calculateFullPnL } from "../math/divergence-loss.js";
import { calculateUsdFeeIncome } from "../services/pnl.js";

describe("calculateUsdFeeIncome", () => {
  it("calculates individual USD fee fields and aggregate when both token prices are available", () => {
    expect(
      calculateUsdFeeIncome({
        feesCollected0: 1.25,
        feesCollected1: 2,
        token0UsdPrice: 10,
        token1UsdPrice: 0.5,
      }),
    ).toEqual({
      feesCollected0Usd: 12.5,
      feesCollected1Usd: 1,
      feesValueUsd: 13.5,
      usdPriceSource: "coingecko",
    });
  });

  it("keeps the available leg populated but aggregate null when a nonzero-fee leg is unpriced", () => {
    expect(
      calculateUsdFeeIncome({
        feesCollected0: 3,
        feesCollected1: 4,
        token0UsdPrice: 2,
        token1UsdPrice: null,
      }),
    ).toEqual({
      feesCollected0Usd: 6,
      feesCollected1Usd: null,
      feesValueUsd: null,
      usdPriceSource: "coingecko",
    });
  });

  it("treats zero fees as 0 even with a missing price, allowing aggregate from the priced leg", () => {
    expect(
      calculateUsdFeeIncome({
        feesCollected0: 0,
        feesCollected1: 4,
        token0UsdPrice: null,
        token1UsdPrice: 2.5,
      }),
    ).toEqual({
      feesCollected0Usd: 0,
      feesCollected1Usd: 10,
      feesValueUsd: 10,
      usdPriceSource: "coingecko",
    });
  });

  it("returns null individual nonzero-fee USD fields, aggregate, and source when no prices are available", () => {
    expect(
      calculateUsdFeeIncome({
        feesCollected0: 1,
        feesCollected1: 2,
        token0UsdPrice: null,
        token1UsdPrice: null,
      }),
    ).toEqual({
      feesCollected0Usd: null,
      feesCollected1Usd: null,
      feesValueUsd: null,
      usdPriceSource: null,
    });
  });

  it("does not alter token1-denominated fee and P&L calculations", () => {
    const pnl = calculateFullPnL({
      entryAmount0Raw: 1_000_000n,
      entryAmount1Raw: 2_000_000n,
      exitAmount0Raw: 1_000_000n,
      exitAmount1Raw: 2_000_000n,
      feesCollected0Raw: 100_000n,
      feesCollected1Raw: 50_000n,
      exitSqrtPriceX96: 2n ** 96n,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1_000_000_000_000n,
      decimals0: 6,
      decimals1: 6,
    });

    const before = {
      feesValue: pnl.feesValue,
      absolutePnl: pnl.absolutePnl,
      absolutePnlPercent: pnl.absolutePnlPercent,
    };

    calculateUsdFeeIncome({
      feesCollected0: pnl.feesCollected0,
      feesCollected1: pnl.feesCollected1,
      token0UsdPrice: null,
      token1UsdPrice: 1,
    });

    expect({
      feesValue: pnl.feesValue,
      absolutePnl: pnl.absolutePnl,
      absolutePnlPercent: pnl.absolutePnlPercent,
    }).toEqual(before);
  });
});
