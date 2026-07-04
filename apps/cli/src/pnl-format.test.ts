import { describe, expect, it } from "bun:test";

import { formatUsd, formatPercent, type PnLView, type HedgeView } from "@lp-tracker/core";

import { formatPnLDisplayData, formatPnLJsonPayload } from "./pnl-format.js";

const basePnL: PnLView = {
  tokenId: "123",
  pair: "HYPE/USDC",
  token0Symbol: "HYPE",
  token1Symbol: "USDC",
  status: "active",
  openedAt: "2024-01-01T00:00:00Z",
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
  pendingFeesValueInToken1: 0,
  pendingFeesValueUsd: 0,
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

// Cluster A: Adversarial tests for hedge integration
describe("formatPnLDisplayData with hedges — Cluster A", () => {
  const baseActiveHedge: HedgeView = {
    tokenId: "123",
    coin: "HYPE",
    szi: "-30",
    entryPx: 10,
    markPx: 8,
    unrealizedPnl: 350,
    fundingEarned: 25.5,
    liquidationPx: 5,
    leverage: { type: "cross", value: 3 },
    status: "active",
  };

  it("Test 1: No hedge in map — all new fields absent, absolutePnl unchanged", () => {
    const result = formatPnLDisplayData([basePnL]); // empty hedgeMap
    const [displayData] = result;

    expect(displayData).toHaveProperty("absolutePnl");
    expect(displayData.absolutePnl).toContain("-1.0000 USDC");
    expect(displayData.absolutePnl).toContain("-0.25%");
    expect(displayData).not.toHaveProperty("lpPnl");
    expect(displayData).not.toHaveProperty("hedgePnl");
    expect(displayData).not.toHaveProperty("netPnl");
  });

  it("Test 2: Active hedge, USD available — lpPnl, hedgePnl, netPnl all present", () => {
    const hedgeMap = new Map([["123", baseActiveHedge]]);
    const result = formatPnLDisplayData([basePnL], hedgeMap);
    const [displayData] = result;

    // lpAbsPnlUsd = -1 * 1 = -1
    // hedgePnlUsd = 350 + 25.5 = 375.5
    // combinedUsd = -1 + 375.5 = 374.5
    // combinedRoiPct = 374.5 / 400 = 0.93625

    expect(displayData).toHaveProperty("lpPnl");
    expect(displayData.lpPnl).toContain(formatUsd(-1));
    expect(displayData.lpPnl).toContain(formatPercent(-0.0025));

    expect(displayData).toHaveProperty("hedgePnl");
    expect(displayData.hedgePnl).toContain(formatUsd(375.5));
    expect(displayData.hedgePnl).toContain("unrealized");
    expect(displayData.hedgePnl).toContain(formatUsd(350));
    expect(displayData.hedgePnl).toContain(formatUsd(25.5));

    expect(displayData).toHaveProperty("netPnl");
    expect(displayData.netPnl).toContain(formatUsd(374.5));
    expect(displayData.netPnl).toContain(formatPercent(374.5 / 400));
  });

  it("Test 3: Active hedge, USD unavailable (token1UsdPrice: null)", () => {
    const hedgeMap = new Map([["123", baseActiveHedge]]);
    const pnlNoUsd = { ...basePnL, token1UsdPrice: null };
    const result = formatPnLDisplayData([pnlNoUsd], hedgeMap);
    const [displayData] = result;

    expect(displayData).not.toHaveProperty("lpPnl");
    expect(displayData).toHaveProperty("hedgePnl");
    expect(displayData.hedgePnl).toContain(formatUsd(375.5));
    expect(displayData).not.toHaveProperty("netPnl");
    expect(displayData).toHaveProperty("absolutePnl");
  });

  it("Test 4: Active hedge with negative hedge P&L", () => {
    const negativeHedge: HedgeView = {
      ...baseActiveHedge,
      unrealizedPnl: -200,
      fundingEarned: 10,
    };
    const hedgeMap = new Map([["123", negativeHedge]]);
    const result = formatPnLDisplayData([basePnL], hedgeMap);
    const [displayData] = result;

    // hedgePnlUsd = -200 + 10 = -190
    // combinedUsd = -1 + (-190) = -191
    // combinedRoiPct = -191 / 400 = -0.4775

    expect(displayData).toHaveProperty("hedgePnl");
    expect(displayData.hedgePnl).toContain(formatUsd(-190));
    expect(displayData.hedgePnl).toContain("unrealized");
    expect(displayData.hedgePnl).toContain(formatUsd(-200));
    expect(displayData.hedgePnl).toContain(formatUsd(10));

    expect(displayData).toHaveProperty("netPnl");
    expect(displayData.netPnl).toContain(formatUsd(-191));
    expect(displayData.netPnl).toContain(formatPercent(-191 / 400));
  });
});

describe("formatPnLJsonPayload with hedges — Cluster A", () => {
  const baseActiveHedge: HedgeView = {
    tokenId: "123",
    coin: "HYPE",
    szi: "-30",
    entryPx: 10,
    markPx: 8,
    unrealizedPnl: 350,
    fundingEarned: 25.5,
    liquidationPx: 5,
    leverage: { type: "cross", value: 3 },
    status: "active",
  };

  it("Test 5: formatPnLJsonPayload with hedgeMap — position has hedge key", () => {
    const hedgeMap = new Map([["123", baseActiveHedge]]);
    const payload = formatPnLJsonPayload([basePnL], hedgeMap);

    expect(payload.positions).toHaveLength(1);
    expect(payload.positions[0]).toHaveProperty("tokenId", "123");
    expect(payload.positions[0]).toHaveProperty("hedge");
    expect(payload.positions[0].hedge).toBe(baseActiveHedge);
  });

  it("Test 6: formatPnLJsonPayload without hedge — position has no hedge key", () => {
    const payload = formatPnLJsonPayload([basePnL]); // empty map

    expect(payload.positions).toHaveLength(1);
    expect(payload.positions[0]).toHaveProperty("tokenId", "123");
    expect(payload.positions[0]).not.toHaveProperty("hedge");
  });

  it("Test 7: formatPnLJsonPayload mixed — two positions, one with hedge, one without", () => {
    const pos2 = { ...basePnL, tokenId: "456" };
    const hedgeMap = new Map([["123", baseActiveHedge]]); // only 123 has hedge
    const payload = formatPnLJsonPayload([basePnL, pos2], hedgeMap);

    expect(payload.positions).toHaveLength(2);
    expect(payload.positions[0]).toHaveProperty("tokenId", "123");
    expect(payload.positions[0]).toHaveProperty("hedge");
    expect(payload.positions[0].hedge).toBe(baseActiveHedge);

    expect(payload.positions[1]).toHaveProperty("tokenId", "456");
    expect(payload.positions[1]).not.toHaveProperty("hedge");
  });
});
