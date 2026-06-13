import { describe, expect, it } from "bun:test";

import { formatUsd, type PnLView, type HedgeView } from "@lp-tracker/core";

import { formatPnLDisplayData } from "./pnl-format.js";

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

  describe("Test 4: Boundary — entryValueInToken1 = 0 (division-by-zero guard)", () => {
    it("omits netPnl when lpEntryUsd = 0 (guard against division by zero)", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: 100,
        fundingEarned: 0,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "active",
        realizedPnl: null,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const pnlWithZeroEntry = { ...basePnL, entryValueInToken1: 0 };
      const [result] = formatPnLDisplayData([pnlWithZeroEntry], hedgeMap);

      // lpEntryUsd = 0 * 1 = 0 → combinedRoiPct guard fails
      expect(result.netPnl).toBeUndefined();
    });
  });

  describe("Test 5: Boundary — combinedUsd = 0 (LP exactly cancels hedge)", () => {
    it("shows $0.00 and +0.00% when LP P&L and hedge P&L cancel out", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: -375.5,
        fundingEarned: 0,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "active",
        realizedPnl: null,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const pnlWithPositiveAbsPnl = {
        ...basePnL,
        absolutePnlInToken1: 375.5,
        absolutePnlPercent: 0.939, // 375.5 / 400
      };
      const [result] = formatPnLDisplayData([pnlWithPositiveAbsPnl], hedgeMap);

      // lpAbsPnlUsd = 375.5 * 1 = 375.5
      // hedgePnlUsd = -375.5 + 0 = -375.5
      // combinedUsd = 375.5 + (-375.5) = 0
      // combinedRoiPct = 0 / 400 = 0
      expect(result.netPnl).toBeDefined();
      expect(result.netPnl).toContain("$0.00");
      expect(result.netPnl).toContain("+0.00%");
    });
  });

  describe("Test 6: Boundary — negative funding earned", () => {
    it("shows negative funding in hedgePnl breakdown", () => {
      const closedHedge: HedgeView = {
        tokenId: "123",
        coin: "HYPE",
        szi: "0",
        entryPx: 10,
        markPx: 10,
        unrealizedPnl: 400,
        fundingEarned: -50,
        liquidationPx: null,
        leverage: { type: "cross", value: 3 },
        status: "active",
        realizedPnl: null,
      };

      const hedgeMap = new Map<string, HedgeView>([["123", closedHedge]]);
      const [result] = formatPnLDisplayData([basePnL], hedgeMap);

      // hedgePnlUsd = 400 + (-50) = 350
      expect(result.hedgePnl).toBeDefined();
      expect(result.hedgePnl).toContain(formatUsd(350));
      expect(result.hedgePnl).toContain(formatUsd(400));
      expect(result.hedgePnl).toContain(formatUsd(-50));
    });
  });

  describe("Test 7: pnlData empty", () => {
    it("returns empty array when pnlData is empty", () => {
      const result = formatPnLDisplayData([], new Map());

      expect(result).toEqual([]);
    });
  });
});
