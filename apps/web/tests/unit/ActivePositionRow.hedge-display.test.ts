import { describe, expect, it } from "bun:test";

import type { HedgeEvent, HedgeView, PnLView } from "../../src/api";
import { buildActivePositionHedgeDisplay } from "../../src/App";

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

const fallbackHedge: HedgeView = {
  tokenId: "123",
  coin: "HYPE",
  szi: "-5.5",
  entryPx: 10.5,
  markPx: 11.2,
  unrealizedPnl: 350,
  fundingEarned: 25.5,
  liquidationPx: 8.5,
  leverage: { type: "cross", value: 1 },
  status: "active",
};

const assignedOpenHedge: HedgeEvent = {
  id: 11,
  token_id: "123",
  trade_key: "trade:hl:HYPE:11",
  tax_key: "tax:hl:HYPE:11",
  coin: "HYPE",
  status: "open",
  entry_px: 42.25,
  size: -3,
  opened_at: "2026-06-20T12:00:00.000Z",
  closed_at: null,
  close_px: null,
  realized_pnl: null,
  funding_earned: 12.34,
  close_reason: null,
  hl_fill_hash: null,
  current_szi: "-3.0",
  mark_px: 40.5,
  unrealized_pnl: 15.25,
  liquidation_px: 55,
  leverage_type: "isolated",
  leverage_value: 3,
  updated_at: "2026-06-20T13:00:00.000Z",
};

describe("buildActivePositionHedgeDisplay", () => {
  it("prefers assigned active hedge events over the legacy hedge view", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [assignedOpenHedge],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    expect(result.fallbackHedge).toBeUndefined();
    expect(result.activeAssignedHedges).toHaveLength(1);
    expect(result.net.hedgePnlUsd).toBe(27.59);
    expect(result.net.combinedPnlUsd).toBe(53.09);
    expect(result.net.combinedRoiPct).toBe(0.5309);
  });

  it("aggregates multiple assigned active hedges", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        assignedOpenHedge,
        {
          ...assignedOpenHedge,
          id: 12,
          trade_key: "trade:hl:HYPE:12",
          tax_key: "tax:hl:HYPE:12",
          unrealized_pnl: -5,
          funding_earned: 1,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    expect(result.net.hedgePnlUsd).toBe(23.59);
    expect(result.net.combinedPnlUsd).toBe(49.09);
  });

  it("adds closed assigned hedge history into assigned ROI/net", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        assignedOpenHedge,
        {
          ...assignedOpenHedge,
          id: 21,
          status: "closed",
          closed_at: "2026-06-21T12:00:00.000Z",
          close_px: 39.75,
          realized_pnl: 25.5,
          unrealized_pnl: null,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    if (result.source !== "assigned") {
      throw new Error("expected assigned hedge source");
    }
    expect(result.net.hedgePnlUsd).toBe(65.43);
    expect(result.net.combinedPnlUsd).toBe(90.93);
    expect(result.net.closedCount).toBe(1);
  });

  it("uses assigned closed hedge history even when there are no assigned open hedges", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        {
          ...assignedOpenHedge,
          id: 22,
          status: "closed",
          closed_at: "2026-06-21T12:00:00.000Z",
          close_px: 39.75,
          realized_pnl: 25.5,
          unrealized_pnl: null,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    if (result.source !== "assigned") {
      throw new Error("expected assigned hedge source");
    }
    expect(result.activeAssignedHedges).toHaveLength(0);
    expect(result.fallbackHedge).toBeUndefined();
    expect(result.net.hedgePnlUsd).toBe(37.84);
    expect(result.net.combinedPnlUsd).toBe(63.34);
    expect(result.net.closedCount).toBe(1);
  });

  it("keeps known assigned hedge P&L but flags partial data when unrealized P&L is missing", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        assignedOpenHedge,
        {
          ...assignedOpenHedge,
          id: 24,
          unrealized_pnl: null,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    if (result.source !== "assigned") {
      throw new Error("expected assigned hedge source");
    }
    expect(result.net.hedgePnlUsd).toBe(27.59);
    expect(result.net.combinedPnlUsd).toBe(53.09);
    expect(result.net.missingUnrealized).toBe(true);
  });

  it("keeps assigned hedge P&L but flags partial funding when funding is unknown", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        {
          ...assignedOpenHedge,
          funding_earned: null,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    if (result.source !== "assigned") {
      throw new Error("expected assigned hedge source");
    }
    expect(result.net.hedgePnlUsd).toBe(15.25);
    expect(result.net.combinedPnlUsd).toBe(40.75);
    expect(result.net.fundingPartial).toBe(true);
  });

  it("falls back to the legacy hedge view when there are no assigned hedges", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [],
      fallbackHedge,
    });

    expect(result.source).toBe("legacy");
    expect(result.fallbackHedge).toEqual(fallbackHedge);
    expect(result.net.hedgePnlUsd).toBe(375.5);
    expect(result.net.combinedPnlUsd).toBe(401);
  });

  it("dedupes duplicate closed assigned lifecycles before adding them into ROI/net", () => {
    const result = buildActivePositionHedgeDisplay({
      pnl,
      assignedHedges: [
        {
          ...assignedOpenHedge,
          id: 20,
          status: "closed",
          closed_at: "2026-06-21T12:00:00.000Z",
          close_px: 39.75,
          realized_pnl: 25.5,
          unrealized_pnl: null,
        },
        {
          ...assignedOpenHedge,
          id: 21,
          hl_fill_hash: "duplicate-close",
          status: "closed",
          closed_at: "2026-06-21T12:00:00.000Z",
          close_px: 39.75,
          realized_pnl: 25.5,
          unrealized_pnl: null,
        },
      ],
      fallbackHedge,
    });

    expect(result.source).toBe("assigned");
    if (result.source !== "assigned") {
      throw new Error("expected assigned hedge source");
    }
    expect(result.activeAssignedHedges).toHaveLength(0);
    expect(result.net.hedgePnlUsd).toBe(37.84);
    expect(result.net.closedCount).toBe(1);
  });
});
