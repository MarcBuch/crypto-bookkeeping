import { createClient } from "../chain/client.js";
import { getPoolAddress, getSlot0, getTokenInfo } from "../chain/pools.js";
import { getAllPositions, type PositionData } from "../chain/positions.js";
import type { Config } from "../config.js";
import { replaceLpCaches, upsertLpSyncState } from "../db/store.js";
import { getTokenAmounts, sqrtPriceX96ToPrice } from "../math/divergence-loss.js";
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
  const client = createClient(config);

  const positions =
    rawPositions ??
    (await getAllPositions(client, config.contracts.positionManager, config.wallet));

  if (positions.length === 0) {
    return [];
  }

  const result: PositionView[] = [];

  for (const pos of positions) {
    const [token0Info, token1Info] = await Promise.all([
      getTokenInfo(client, pos.token0),
      getTokenInfo(client, pos.token1),
    ]);

    const poolAddress = await getPoolAddress(
      client,
      config.contracts.factory,
      pos.token0,
      pos.token1,
      pos.fee,
    );

    const poolSlot0 = await getSlot0(client, poolAddress);

    const currentAmounts = getTokenAmounts(
      pos.liquidity,
      poolSlot0.sqrtPriceX96,
      pos.tickLower,
      pos.tickUpper,
    );

    const priceLower = 1.0001 ** pos.tickLower * 10 ** (token0Info.decimals - token1Info.decimals);
    const priceUpper = 1.0001 ** pos.tickUpper * 10 ** (token0Info.decimals - token1Info.decimals);

    const currentPrice = sqrtPriceX96ToPrice(
      poolSlot0.sqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );

    const inRange = poolSlot0.tick >= pos.tickLower && poolSlot0.tick < pos.tickUpper;
    const isActive = pos.liquidity > 0n;

    const amount0Human = Number(currentAmounts.amount0) / 10 ** token0Info.decimals;
    const amount1Human = Number(currentAmounts.amount1) / 10 ** token1Info.decimals;

    result.push({
      tokenId: pos.tokenId.toString(),
      token0: { address: pos.token0, symbol: token0Info.symbol, decimals: token0Info.decimals },
      token1: { address: pos.token1, symbol: token1Info.symbol, decimals: token1Info.decimals },
      fee: pos.fee,
      feePercent: pos.fee / 10000,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      priceLower,
      priceUpper,
      currentPrice,
      liquidity: pos.liquidity.toString(),
      status: isActive ? "active" : "closed",
      inRange,
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
  replaceLpCaches(
    positions as unknown as Record<string, unknown>[],
    pnlViews as unknown as Record<string, unknown>[],
    syncedAt,
  );

  // Update sync state
  upsertLpSyncState({ wallet: config.wallet, last_synced_at: syncedAt });

  return {
    wallet: config.wallet,
    syncedAt,
    positionCount: positions.length,
  };
}
