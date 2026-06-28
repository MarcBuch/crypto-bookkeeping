import { describe, expect, it } from "bun:test";

import type { HedgeEvent, HedgeView, PnLView } from "../../src/api";
import { buildBlotterPnl, sumClosedAssignedHedgePnl } from "../../src/App";

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

  it("sums multiple closed assigned hedge events and ignores open events in row totals", () => {
    const assignedHedges: HedgeEvent[] = [
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -5,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 40,
        funding_earned: 5.5,
        close_reason: "manual_close",
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 2,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 12,
        size: -4,
        opened_at: "2026-06-21T00:00:00.000Z",
        closed_at: "2026-06-21T04:00:00.000Z",
        close_px: 11,
        realized_pnl: -10,
        funding_earned: null,
        close_reason: "manual_close",
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 3,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "open",
        entry_px: 13,
        size: -2,
        opened_at: "2026-06-22T00:00:00.000Z",
        closed_at: null,
        close_px: null,
        realized_pnl: null,
        funding_earned: 99,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: "-2",
        mark_px: 12,
        unrealized_pnl: 30,
        liquidation_px: 20,
        leverage_type: "cross",
        leverage_value: 2,
        updated_at: "2026-06-22T01:00:00.000Z",
      },
    ];

    const result = buildBlotterPnl(pnl, undefined, assignedHedges);

    expect(result.closedHedgePnlUsd).toBe(35.5);
    expect(result.closedHedgePnlInToken1).toBe(35.5);
    expect(result.displayedPnlInToken1).toBe(61);
    expect(result.closedHedgeCount).toBe(2);
    expect(result.closedHedgeFundingUnknown).toBe(true);
  });

  it("reduces assigned closed hedge contribution when known funding is negative", () => {
    const assignedHedges: HedgeEvent[] = [
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -5,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 40,
        funding_earned: -3.25,
        close_reason: "manual_close",
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
    ];

    const result = buildBlotterPnl(pnl, undefined, assignedHedges);

    expect(result.closedHedgePnlUsd).toBe(36.75);
    expect(result.closedHedgePnlInToken1).toBe(36.75);
    expect(result.displayedPnlInToken1).toBe(62.25);
    expect(result.closedHedgeFundingUnknown).toBe(false);
  });

  it("keeps assigned closed hedge USD known but token1 conversion null when token1UsdPrice is missing", () => {
    const assignedHedges: HedgeEvent[] = [
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -5,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 40,
        funding_earned: 5.5,
        close_reason: "manual_close",
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
    ];

    const result = buildBlotterPnl({ ...pnl, token1UsdPrice: null }, undefined, assignedHedges);

    expect(result.closedHedgePnlUsd).toBe(45.5);
    expect(result.closedHedgePnlInToken1).toBeNull();
    expect(result.displayedPnlInToken1).toBe(25.5);
    expect(result.displayedPnlUsd).toBeNull();
    expect(result.includesClosedHedge).toBe(false);
  });

  it("prefers assigned closed hedge history over legacy closed hedge view to avoid double counting", () => {
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
    const assignedHedges: HedgeEvent[] = [
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -5,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 10,
        funding_earned: 2,
        close_reason: "manual_close",
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
    ];

    const result = buildBlotterPnl(pnl, hedge, assignedHedges);

    expect(result.closedHedgePnlUsd).toBe(12);
    expect(result.displayedPnlInToken1).toBe(37.5);
  });
});

describe("sumClosedAssignedHedgePnl", () => {
  it("counts realized P&L and only known funding", () => {
    const result = sumClosedAssignedHedgePnl([
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 5,
        funding_earned: null,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 2,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: null,
        funding_earned: 3,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
    ]);

    expect(result.totalUsd).toBe(8);
    expect(result.count).toBe(2);
    expect(result.fundingUnknown).toBe(true);
  });

  it("sums three closed hedges, ignores open hedges, and subtracts negative funding", () => {
    const result = sumClosedAssignedHedgePnl([
      {
        id: 1,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-20T00:00:00.000Z",
        closed_at: "2026-06-20T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 20,
        funding_earned: 2,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 2,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-21T00:00:00.000Z",
        closed_at: "2026-06-21T04:00:00.000Z",
        close_px: 9,
        realized_pnl: -5,
        funding_earned: -1.5,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 3,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "closed",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-22T00:00:00.000Z",
        closed_at: "2026-06-22T04:00:00.000Z",
        close_px: 9,
        realized_pnl: 7,
        funding_earned: null,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: null,
        mark_px: null,
        unrealized_pnl: null,
        liquidation_px: null,
        leverage_type: null,
        leverage_value: null,
        updated_at: null,
      },
      {
        id: 4,
        token_id: "123",
        trade_key: null,
        tax_key: null,
        coin: "HYPE",
        status: "open",
        entry_px: 10,
        size: -1,
        opened_at: "2026-06-23T00:00:00.000Z",
        closed_at: null,
        close_px: null,
        realized_pnl: 999,
        funding_earned: 999,
        close_reason: null,
        hl_fill_hash: null,
        current_szi: "-1",
        mark_px: 8,
        unrealized_pnl: 50,
        liquidation_px: 20,
        leverage_type: "cross",
        leverage_value: 1,
        updated_at: null,
      },
    ]);

    expect(result.totalUsd).toBe(22.5);
    expect(result.count).toBe(3);
    expect(result.fundingUnknown).toBe(true);
  });
});
