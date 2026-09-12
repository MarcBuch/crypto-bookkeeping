import { createClient } from "../chain/client.js";
import { getAllPositions, getPositionData, type PositionData } from "../chain/positions.js";
import type { Config } from "../config.js";
import {
  listCachedPnLViews,
  upsertLpCacheRows,
  upsertLpSyncOutcome,
  upsertLpSyncState,
  upsertPositionViewCache,
  upsertPnLViewCache,
} from "../db/store.js";
import { getHedgeView, snapshotHedge, syncHyperliquidHedgeTrades } from "./hedge.js";
import type { PnLView, PositionSyncOutcome } from "./pnl.js";
import { resolvePnLViewsDetailed } from "./pnl.js";
import { createPositionLifecycleContext, projectCurrentPosition } from "./position-lifecycle.js";

type CachedPnLView = Record<string, unknown>;

function readCachedNumber(view: CachedPnLView | undefined, key: keyof PnLView): number | null {
  const value = view?.[key];
  return typeof value === "number" ? value : null;
}

const usdValuationKeys = [
  "token0UsdPrice",
  "token1UsdPrice",
  "entryToken0UsdPrice",
  "entryToken1UsdPrice",
  "entryValueUsd",
  "feesCollected0Usd",
  "feesCollected1Usd",
  "feesValueUsd",
  "pendingFeesValueUsd",
  "pnlUsd",
  "usdPriceSource",
  "pnlUsdCompleteness",
  "pnlUsdSource",
] as const;

function cachedUsdSnapshot(cached: CachedPnLView): Partial<PnLView> {
  return Object.fromEntries(
    usdValuationKeys.filter((key) => key in cached).map((key) => [key, cached[key]]),
  ) as Partial<PnLView>;
}

export function mergeCachedUsdFields(fresh: PnLView, cached?: CachedPnLView): PnLView {
  if (!cached) return fresh;
  if (typeof fresh.pnlUsd === "number") return fresh;
  const cachedPnlUsd = readCachedNumber(cached, "pnlUsd");
  const hasLegacyCachedSnapshot =
    readCachedNumber(cached, "token0UsdPrice") !== null ||
    readCachedNumber(cached, "token1UsdPrice") !== null;
  if (cachedPnlUsd === null && !hasLegacyCachedSnapshot) return fresh;

  const preservedUsd = Object.fromEntries(
    Object.entries(cachedUsdSnapshot(cached)).filter(([, value]) => value != null),
  ) as Partial<PnLView>;
  const merged: PnLView = {
    ...fresh,
    ...preservedUsd,
    pnlUsdCompleteness:
      cached.pnlUsdCompleteness === "complete" || cached.pnlUsdCompleteness === "partial"
        ? cached.pnlUsdCompleteness
        : cachedPnlUsd !== null
          ? "partial"
          : "unpriced",
    pnlUsdSource:
      cached.pnlUsdSource === "event_time" ||
      cached.pnlUsdSource === "live" ||
      cached.pnlUsdSource === "mixed"
        ? cached.pnlUsdSource
        : null,
  };

  if (
    merged.entryValueUsd == null &&
    merged.entryToken0UsdPrice == null &&
    merged.entryToken1UsdPrice == null &&
    merged.token0UsdPrice == null &&
    merged.token1UsdPrice == null &&
    merged.feesValueUsd == null &&
    cachedPnlUsd != null
  ) {
    merged.pnlUsd = cachedPnlUsd;
  }

  return merged;
}

function cachedPnlViewsByTokenId(): Map<string, CachedPnLView> {
  return new Map(listCachedPnLViews().map((row) => [String(row.tokenId), row]));
}

function cachedPnlView(tokenId: string): CachedPnLView | undefined {
  return listCachedPnLViews().find((row) => String(row.tokenId) === tokenId);
}

export interface PositionView {
  tokenId: string;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  fee: number;
  feePercent: number;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
  liquidity: string;
  status: "active" | "closed";
  inRange: boolean;
  currentAmount0: number;
  currentAmount1: number;
}

export async function getPositionsView(
  config: Config,
  rawPositions?: PositionData[],
): Promise<PositionView[]> {
  const lifecycleContext = await createPositionLifecycleContext(config);
  const client = lifecycleContext.client;

  const positions =
    rawPositions ??
    (await getAllPositions(client, config.contracts.positionManager, config.wallet));

  if (positions.length === 0) {
    return [];
  }

  const result: PositionView[] = [];

  for (const pos of positions) {
    try {
      const projection = await projectCurrentPosition(lifecycleContext, pos);
      const amount0Human = Number(projection.currentAmount0) / 10 ** projection.token0Info.decimals;
      const amount1Human = Number(projection.currentAmount1) / 10 ** projection.token1Info.decimals;

      result.push({
        tokenId: pos.tokenId.toString(),
        token0: {
          address: pos.token0,
          symbol: projection.token0Info.symbol,
          decimals: projection.token0Info.decimals,
        },
        token1: {
          address: pos.token1,
          symbol: projection.token1Info.symbol,
          decimals: projection.token1Info.decimals,
        },
        fee: pos.fee,
        feePercent: pos.fee / 10000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        priceLower: projection.priceLower,
        priceUpper: projection.priceUpper,
        currentPrice: projection.currentPrice,
        liquidity: pos.liquidity.toString(),
        status: projection.status,
        inRange: projection.inRange,
        currentAmount0: amount0Human,
        currentAmount1: amount1Human,
      });
    } catch (error) {
      // Skip the position but let the rest of the loop continue; any previous
      // cache row for this position survives untouched.
      console.error(`[lp-tracker] Failed to project position ${pos.tokenId.toString()}:`, error);
    }
  }

  return result;
}

export interface SyncLpDataSummary {
  wallet: string;
  syncedAt: string;
  positionCount: number;
  hedgeTradesSynced: number;
  hedgeSyncError?: string;
  outcomes: PositionSyncOutcome[];
}

export async function syncLpData(config: Config): Promise<SyncLpDataSummary> {
  // Fetch sequentially to reduce simultaneous RPC/rate-limit pressure
  const client = createClient(config);
  const rawPositions = await getAllPositions(
    client,
    config.contracts.positionManager,
    config.wallet,
  );
  const positions = await getPositionsView(config, rawPositions);
  const { views: pnlViews, outcomes } = await resolvePnLViewsDetailed(
    config,
    undefined,
    rawPositions,
  );
  const cachedPnlViews = cachedPnlViewsByTokenId();
  const mergedPnlViews = pnlViews.map((view) =>
    mergeCachedUsdFields(view, cachedPnlViews.get(view.tokenId)),
  );

  const syncedAt = new Date().toISOString();

  // Upsert both caches in a single transaction. Never deletes: rows for
  // positions absent from this sync (e.g. burned NFTs) are preserved.
  upsertLpCacheRows(positions, mergedPnlViews, syncedAt);

  // Update sync state
  upsertLpSyncState({ wallet: config.wallet, last_synced_at: syncedAt });

  // Record one outcome row per wallet position, stamped with this sync's timestamp
  for (const pos of rawPositions) {
    const tokenId = pos.tokenId.toString();
    const outcome = outcomes.find((candidate) => candidate.tokenId === tokenId);
    upsertLpSyncOutcome({
      tokenId,
      syncedAt,
      outcome: outcome?.outcome ?? "failed",
      entrySource: outcome?.entrySource,
      exitSource: outcome?.exitSource,
      error: outcome?.error,
      warnings: outcome?.warnings,
    });
  }

  // Snapshot hedges for each position (if configured)
  for (const position of positions) {
    const positionConfig = config.positions?.[position.tokenId];
    if (positionConfig?.hedge) {
      try {
        const hedgeView = await getHedgeView(config, position.tokenId);
        snapshotHedge(hedgeView);
      } catch (err) {
        // Log but do NOT re-throw — LP sync must complete even if HL API is down
        console.warn(`[hedge] Failed to snapshot hedge for ${position.tokenId}:`, err);
      }
    }
  }

  let hedgeTradesSynced = 0;
  let hedgeSyncError: string | undefined;
  try {
    hedgeTradesSynced = await syncHyperliquidHedgeTrades(config);
  } catch (err) {
    hedgeSyncError = err instanceof Error ? err.message : String(err);
    console.warn("[hedge] Failed to sync hedge trades:", err);
  }

  const summary: SyncLpDataSummary = {
    wallet: config.wallet,
    syncedAt,
    positionCount: positions.length,
    hedgeTradesSynced,
    outcomes,
  };

  if (hedgeSyncError) {
    summary.hedgeSyncError = hedgeSyncError;
  }

  return summary;
}

export interface SyncSinglePositionSummary {
  tokenId: string;
  syncedAt: string;
}

export async function syncSinglePosition(
  config: Config,
  tokenId: string,
): Promise<SyncSinglePositionSummary> {
  // 1. Validate: tokenId must be a non-empty numeric string
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    throw new Error(`Invalid tokenId: "${tokenId}"`);
  }

  // 2. Create viem client
  const client = createClient(config);
  const positionConfig = config.positions?.[tokenId];
  const hedgePromise = positionConfig?.hedge
    ? getHedgeView(config, tokenId)
        .then((hedgeView) => ({ hedgeView }))
        .catch((error: unknown) => ({ error }))
    : null;

  // 3. Fetch position data for this specific tokenId (bypasses wallet enumeration)
  const rawPosition = await getPositionData(
    client,
    config.contracts.positionManager,
    BigInt(tokenId),
  );

  // 4. Get position view and PnL view for just this one position concurrently
  const [positionView, pnlResult] = await Promise.all([
    getPositionsView(config, [rawPosition]),
    resolvePnLViewsDetailed(config, tokenId, [rawPosition]),
  ]);
  const pnlView = pnlResult.views;
  if (positionView[0] === undefined) {
    throw new Error(`Position #${tokenId} not found or has no view data`);
  }

  // pnlView may be undefined/null if no PnL data exists — that's OK, don't throw

  // 5. Upsert only this position's cache rows (leave all other positions untouched)
  const syncedAt = new Date().toISOString();
  upsertPositionViewCache(tokenId, positionView[0], syncedAt);
  if (pnlView[0]) {
    upsertPnLViewCache(tokenId, mergeCachedUsdFields(pnlView[0], cachedPnlView(tokenId)), syncedAt);
  }

  // Record this position's outcome, stamped with the same syncedAt
  const outcome = pnlResult.outcomes.find((candidate) => candidate.tokenId === tokenId);
  upsertLpSyncOutcome({
    tokenId,
    syncedAt,
    outcome: outcome?.outcome ?? "failed",
    entrySource: outcome?.entrySource,
    exitSource: outcome?.exitSource,
    error: outcome?.error,
    warnings: outcome?.warnings,
  });

  // 6. Snapshot hedge if configured (swallow errors — LP sync must complete)
  if (hedgePromise) {
    const hedgeResult = await hedgePromise;
    if ("hedgeView" in hedgeResult) {
      const hedgeView = hedgeResult.hedgeView;
      snapshotHedge(hedgeView);
    } else {
      // Log but do NOT re-throw — LP sync must complete even if HL API is down
      console.warn(`[hedge] Failed to snapshot hedge for ${tokenId}:`, hedgeResult.error);
    }
  }

  // 7. Return summary
  return { tokenId, syncedAt };
}
