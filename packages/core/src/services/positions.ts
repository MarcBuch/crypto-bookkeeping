import { createClient } from "../chain/client.js";
import { getAllPositions, getPositionData, type PositionData } from "../chain/positions.js";
import type { Config } from "../config.js";
import {
  replaceLpCaches,
  upsertLpSyncState,
  upsertPositionViewCache,
  upsertPnLViewCache,
} from "../db/store.js";
import { getHedgeView, snapshotHedge } from "./hedge.js";
import {
  createPositionLifecycleContext,
  projectCurrentPosition,
} from "./position-lifecycle.js";
import { getPnLView } from "./pnl.js";

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
  }

  return result;
}

export interface SyncLpDataSummary {
  wallet: string;
  syncedAt: string;
  positionCount: number;
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
  const pnlViews = await getPnLView(config, undefined, rawPositions);

  const syncedAt = new Date().toISOString();

  // Atomically replace both caches in a single transaction
  replaceLpCaches(positions, pnlViews, syncedAt);

  // Update sync state
  upsertLpSyncState({ wallet: config.wallet, last_synced_at: syncedAt });

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

  return {
    wallet: config.wallet,
    syncedAt,
    positionCount: positions.length,
  };
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

  // 4. Get position view for just this one position
  const [positionView] = await getPositionsView(config, [rawPosition]);
  if (positionView === undefined) {
    throw new Error(`Position #${tokenId} not found or has no view data`);
  }

  // 5. Get PnL view for just this one position
  const [pnlView] = await getPnLView(config, tokenId, [rawPosition]);
  // pnlView may be undefined/null if no PnL data exists — that's OK, don't throw

  // 6. Upsert only this position's cache rows (leave all other positions untouched)
  const syncedAt = new Date().toISOString();
  upsertPositionViewCache(tokenId, positionView, syncedAt);
  if (pnlView) {
    upsertPnLViewCache(tokenId, pnlView, syncedAt);
  }

  // 7. Snapshot hedge if configured (swallow errors — LP sync must complete)
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

  // 8. Return summary
  return { tokenId, syncedAt };
}
