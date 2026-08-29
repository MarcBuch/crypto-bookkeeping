import { describe, expect, it } from "bun:test";

import { formatUsd, type PnLView, type HedgeView } from "@lp-tracker/core";

import { formatPnLDisplayData } from "./pnl-format.js";

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

describe("formatPnLDisplayData — Cluster B: closed hedge & boundaries", () => {
  describe("Test 1: Closed hedge with realizedPnl set", () => {
    it("combines realized P&L and funding earned into hedgePnl, calculates netPnl", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: 0,
        fundingEarned: 25.5,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "closed",
        realizedPnl: 200,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const [result] = formatPnLDisplayData([basePnL], hedgeMap);

      // hedgePnlUsd = 200 + 25.5 = 225.5
      expect(result.hedgePnl).toBeDefined();
      expect(result.hedgePnl).toContain("realized");
      expect(result.hedgePnl).toContain(formatUsd(225.5));
      expect(result.hedgePnl).toContain(formatUsd(200));
      expect(result.hedgePnl).toContain(formatUsd(25.5));

      // netPnl = lpAbsPnlUsd + hedgePnlUsd = -1 + 225.5 = 224.5
      expect(result.netPnl).toBeDefined();
      expect(result.netPnl).toContain(formatUsd(224.5));
    });
  });

  describe("Test 2: Closed hedge with realizedPnl = null", () => {
    it("shows 'realized P&L unknown' and funding earned, omits netPnl", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: 0,
        fundingEarned: 25.5,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "closed",
        realizedPnl: null,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const [result] = formatPnLDisplayData([basePnL], hedgeMap);

      // hedgePnlUsd = null (realizedPnl is null)
      expect(result.hedgePnl).toBeDefined();
      expect(result.hedgePnl).toContain("realized P&L unknown");
      expect(result.hedgePnl).toContain(formatUsd(25.5));

      // netPnl should be absent (hedgePnlUsd is null)
      expect(result.netPnl).toBeUndefined();
    });
  });

  describe("Test 3: Closed hedge with realizedPnl = 0 (zero is valid)", () => {
    it("includes zero realized P&L in hedgePnl, calculates netPnl", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: 0,
        fundingEarned: 25.5,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "closed",
        realizedPnl: 0,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const [result] = formatPnLDisplayData([basePnL], hedgeMap);

      // hedgePnlUsd = 0 + 25.5 = 25.5
      expect(result.hedgePnl).toBeDefined();
      expect(result.hedgePnl).toContain("realized");
      expect(result.hedgePnl).toContain(formatUsd(0));
      expect(result.hedgePnl).toContain(formatUsd(25.5));

      // netPnl = lpAbsPnlUsd + hedgePnlUsd = -1 + 25.5 = 24.5
      expect(result.netPnl).toBeDefined();
      expect(result.netPnl).toContain(formatUsd(24.5));
    });
  });

});
