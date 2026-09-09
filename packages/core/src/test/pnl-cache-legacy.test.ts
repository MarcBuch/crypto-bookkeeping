import { describe, expect, it } from "bun:test";

import { upsertPnLViewCache } from "../db/store.js";
import { mergeCachedUsdFields } from "../services/positions.js";
import { useTestDb } from "./helpers/db.js";

useTestDb();

describe("legacy pnl_view_cache rows", () => {
  it("fills missing new USD fields from a legacy cache row without destroying legacy USD values", async () => {
    const tokenId = "542375";
    const syncedAt = "2026-09-09T00:00:00.000Z";
    const fresh = {
      tokenId,
      pair: "UBTC/USDC",
      token0Symbol: "UBTC",
      token1Symbol: "USDC",
      status: "active",
      entryPrice: 1,
      exitPrice: 1,
      priceChangePercent: 0,
      entryAmount0: 1,
      entryAmount1: 1,
      exitAmount0: 1,
      exitAmount1: 1,
      feesCollected0: 0,
      feesCollected1: 0,
      feesCollected0Usd: 0,
      feesCollected1Usd: 0,
      feesValueUsd: null,
      token0UsdPrice: null,
      token1UsdPrice: null,
      usdPriceSource: null,
      feesValueInToken1: 0,
      pendingFeesValueInToken1: 0,
      pendingFeesValueUsd: null,
      entryToken0UsdPrice: null,
      entryToken1UsdPrice: null,
      entryValueUsd: null,
      entryValueInToken1: 2,
      exitValueInToken1: 2,
      holdValueInToken1: 2,
      absolutePnlInToken1: 0,
      absolutePnlPercent: 0,
      divergenceLossPercent: 0,
      opportunityCostInToken1: 0,
      netVsHodlPercent: 0,
      priceLower: 0,
      priceUpper: 0,
      pnlUsd: null,
      pnlUsdCompleteness: "unpriced",
      pnlUsdSource: null,
    };

    const cached = {
      ...fresh,
      token0UsdPrice: 123.45,
      token1UsdPrice: 1,
      feesValueUsd: 4,
      pnlUsd: 5,
    };

    upsertPnLViewCache(tokenId, cached, syncedAt);

    expect(mergeCachedUsdFields(fresh as never, cached as never)).toMatchObject({
      token0UsdPrice: 123.45,
      token1UsdPrice: 1,
      feesValueUsd: 4,
      pnlUsd: 5,
      pnlUsdCompleteness: "partial",
      pnlUsdSource: null,
    });
  });
});
