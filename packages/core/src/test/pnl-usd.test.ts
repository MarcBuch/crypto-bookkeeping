import { describe, expect, it } from "bun:test";

import { calculateLpEconomics } from "../services/lp-economics.js";
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

  it("uses available priced legs for aggregate USD fees when a nonzero-fee leg is unpriced", () => {
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
      feesValueUsd: 6,
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
    const economics = calculateLpEconomics({
      pos: { tickLower: -100, tickUpper: 100 },
      token0Info: { decimals: 6 },
      token1Info: { decimals: 6 },
      entryAmount0: 1_000_000n,
      entryAmount1: 2_000_000n,
      entryLiquidity: 1_000_000_000_000n,
      exitAmount0: 1_000_000n,
      exitAmount1: 2_000_000n,
      pendingFees0: 0n,
      pendingFees1: 0n,
      totalFees0: 100_000n,
      totalFees1: 50_000n,
      exitSqrtPriceX96: 2n ** 96n,
    });

    const before = {
      feesValue: economics.totalFeesValueInToken1,
      absolutePnl: economics.absolutePnlInToken1,
      absolutePnlPercent: economics.absolutePnlPercent,
    };

    calculateUsdFeeIncome({
      feesCollected0: economics.totalFees0,
      feesCollected1: economics.totalFees1,
      token0UsdPrice: null,
      token1UsdPrice: 1,
    });

    expect({
      feesValue: economics.totalFeesValueInToken1,
      absolutePnl: economics.absolutePnlInToken1,
      absolutePnlPercent: economics.absolutePnlPercent,
    }).toEqual(before);
  });
});
