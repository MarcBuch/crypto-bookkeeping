import { describe, expect, it } from "bun:test";
import type { PnLView } from "@lp-tracker/core";
import { formatPnLDisplayData, formatPnLJsonPayload } from "./pnl-format.js";

const basePnL: PnLView = {
  tokenId: "123",
  pair: "HYPE/USDC",
  token0Symbol: "HYPE",
  token1Symbol: "USDC",
  status: "active",
  entryPrice: 20,
  exitPrice: 21,
  priceChangePercent: 0.05,
  entryAmount0: 10,
  entryAmount1: 200,
  exitAmount0: 9,
  exitAmount1: 210,
  feesCollected0: 1.25,
  feesCollected1: 2.5,
  feesCollected0Usd: 25,
  feesCollected1Usd: 2.5,
  feesValueUsd: 27.5,
  token0UsdPrice: 20,
  token1UsdPrice: 1,
  usdPriceSource: "coingecko",
  feesValueInToken1: 28.75,
  entryValueInToken1: 400,
  exitValueInToken1: 399,
  holdValueInToken1: 410,
  absolutePnlInToken1: -1,
  absolutePnlPercent: -0.0025,
  divergenceLossPercent: -0.0268,
  opportunityCostInToken1: -11,
  netVsHodlPercent: -0.0268,
  priceLower: 10,
  priceUpper: 30,
};

describe("formatPnLJsonPayload", () => {
  it("keeps raw PnL objects, including USD fields, unchanged under positions", () => {
    const payload = formatPnLJsonPayload([basePnL]);

    expect(payload).toEqual({ positions: [basePnL] });
    expect(payload.positions[0]).toBe(basePnL);
    expect(payload.positions[0]).toHaveProperty("feesValueUsd", 27.5);
    expect(payload.positions[0]).toHaveProperty("feesCollected0Usd", 25);
    expect(payload.positions[0]).toHaveProperty("feesCollected1Usd", 2.5);
  });
});

describe("formatPnLDisplayData", () => {
  it("includes native token1-denominated fee content and USD fees when available", () => {
    const [{ feesEarned }] = formatPnLDisplayData([basePnL]);

    expect(feesEarned).toContain("1.2500 HYPE + 2.5000 USDC");
    expect(feesEarned).toContain("= 28.7500 USDC");
    expect(feesEarned).toContain("USD fees $27.50");
  });

  it("includes USD fees $0 when USD fee value is zero", () => {
    const [{ feesEarned }] = formatPnLDisplayData([{ ...basePnL, feesValueUsd: 0 }]);

    expect(feesEarned).toContain("USD fees $0");
  });

  it("marks USD fees unavailable when USD fee value is null", () => {
    const [{ feesEarned }] = formatPnLDisplayData([{ ...basePnL, feesValueUsd: null }]);

    expect(feesEarned).toContain("USD fees unavailable");
    expect(feesEarned).toContain("1.2500 HYPE + 2.5000 USDC");
    expect(feesEarned).toContain("= 28.7500 USDC");
  });
});
