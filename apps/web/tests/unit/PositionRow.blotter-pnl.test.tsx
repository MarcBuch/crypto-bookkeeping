import { describe, expect, it } from "bun:test";

import type { HedgeView, PnLView } from "../../src/api";
import { buildBlotterPnl } from "../../src/App";

const pnl: PnLView = {
  tokenId: "123",
  pair: "WHYPE/USDC",
  token0Symbol: "WHYPE",
  token1Symbol: "USDC",
  status: "active",
  entryPrice: 1,
  exitPrice: 1.5,
  priceChangePercent: 0.5,
  entryAmount0: 1,
  entryAmount1: 100,
  exitAmount0: 1,
  exitAmount1: 120,
  feesCollected0: 0.1,
  feesCollected1: 2,
  feesCollected0Usd: 1.23,
  feesCollected1Usd: 2,
  feesValueInToken1: 12.345,
  feesValueUsd: 3.23,
  pendingFeesValueInToken1: 0.5,
  pendingFeesValueUsd: 0.1,
  token0UsdPrice: 12.3,
  token1UsdPrice: 1,
  usdPriceSource: "coingecko",
  entryValueInToken1: 100,
  exitValueInToken1: 125,
  holdValueInToken1: 120,
  absolutePnlInToken1: 25.5,
  absolutePnlPercent: 0.255,
  divergenceLossPercent: -0.01,
  opportunityCostInToken1: 2,
  netVsHodlPercent: 0.05,
  priceLower: 1,
  priceUpper: 2,
};

describe("buildBlotterPnl", () => {
  it("keeps LP-only P&L when there is no hedge", () => {
    const result = buildBlotterPnl(pnl, undefined);

    expect(result.displayedPnlInToken1).toBe(25.5);
    expect(result.displayedPnlUsd).toBe(25.5);
    expect(result.closedHedgePnlUsd).toBeNull();
    expect(result.includesClosedHedge).toBe(false);
  });

  it("adds closed hedge P&L into the LP row when token1 USD price is known", () => {
    const hedge: HedgeView = {
      tokenId: "123",
      coin: "HYPE",
      szi: "0",
      entryPx: 10,
      markPx: 9,
      unrealizedPnl: 0,
      fundingEarned: 5.5,
      liquidationPx: null,
      leverage: { type: "cross", value: 1 },
      status: "closed",
      realizedPnl: 40,
      closedAt: "2026-06-20T00:00:00.000Z",
      closeReason: "manual_close",
    };

    const result = buildBlotterPnl(pnl, hedge);

    expect(result.closedHedgePnlUsd).toBe(45.5);
    expect(result.closedHedgePnlInToken1).toBe(45.5);
    expect(result.displayedPnlInToken1).toBe(71);
    expect(result.displayedPnlUsd).toBe(71);
    expect(result.includesClosedHedge).toBe(true);
  });

  it("does not fold closed hedge P&L into token1 totals when token1 USD price is missing", () => {
    const hedge: HedgeView = {
      tokenId: "123",
      coin: "HYPE",
      szi: "0",
      entryPx: 10,
      markPx: 9,
      unrealizedPnl: 0,
      fundingEarned: 5.5,
      liquidationPx: null,
      leverage: { type: "cross", value: 1 },
      status: "closed",
      realizedPnl: 40,
      closedAt: "2026-06-20T00:00:00.000Z",
      closeReason: "manual_close",
    };

    const result = buildBlotterPnl({ ...pnl, token1UsdPrice: null }, hedge);

    expect(result.closedHedgePnlUsd).toBe(45.5);
    expect(result.closedHedgePnlInToken1).toBeNull();
    expect(result.displayedPnlInToken1).toBe(25.5);
    expect(result.displayedPnlUsd).toBeNull();
    expect(result.includesClosedHedge).toBe(false);
  });

  it("does not add active hedge P&L to blotter LP totals", () => {
    const hedge: HedgeView = {
      tokenId: "123",
      coin: "HYPE",
      szi: "-5",
      entryPx: 10,
      markPx: 9,
      unrealizedPnl: 40,
      fundingEarned: 5.5,
      liquidationPx: 20,
      leverage: { type: "cross", value: 1 },
      status: "active",
    };

    const result = buildBlotterPnl(pnl, hedge);

    expect(result.closedHedgePnlUsd).toBeNull();
    expect(result.displayedPnlInToken1).toBe(25.5);
    expect(result.displayedPnlUsd).toBe(25.5);
    expect(result.includesClosedHedge).toBe(false);
  });
});
