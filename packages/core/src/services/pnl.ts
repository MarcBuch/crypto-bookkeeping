import { createClient } from "../chain/client.js";
import { getAllPositions, type PositionData } from "../chain/positions.js";
import type { Config } from "../config.js";
import { sqlitePositionStore } from "../db/position-store.js";
import { calculateFullPnL } from "../math/divergence-loss.js";
import { NotFoundError } from "./errors.js";
import {
  createPositionLifecycleContext,
  resolvePositionLifecycle,
} from "./position-lifecycle.js";
import { getHistoricalPrice, getUsdPrices } from "./pricing.js";

export interface PnLView {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  status: "active" | "closed";
  entryPrice: number;
  exitPrice: number;
  priceChangePercent: number;
  entryAmount0: number;
  entryAmount1: number;
  exitAmount0: number;
  exitAmount1: number;
  feesCollected0: number;
  feesCollected1: number;
  feesCollected0Usd: number | null;
  feesCollected1Usd: number | null;
  feesValueUsd: number | null;
  token0UsdPrice: number | null;
  token1UsdPrice: number | null;
  usdPriceSource: "coingecko" | null;
  feesValueInToken1: number;
  pendingFeesValueInToken1: number;
  pendingFeesValueUsd: number | null;
  entryValueInToken1: number;
  exitValueInToken1: number;
  holdValueInToken1: number;
  absolutePnlInToken1: number;
  absolutePnlPercent: number;
  divergenceLossPercent: number;
  opportunityCostInToken1: number;
  netVsHodlPercent: number;
  priceLower: number;
  priceUpper: number;
}

export interface UsdFeeIncome {
  feesCollected0Usd: number | null;
  feesCollected1Usd: number | null;
  feesValueUsd: number | null;
  usdPriceSource: "coingecko" | null;
}

export function calculateUsdFeeIncome(params: {
  feesCollected0: number;
  feesCollected1: number;
  token0UsdPrice: number | null;
  token1UsdPrice: number | null;
}): UsdFeeIncome {
  const feesCollected0Usd =
    params.feesCollected0 === 0
      ? 0
      : params.token0UsdPrice === null
        ? null
        : params.feesCollected0 * params.token0UsdPrice;
  const feesCollected1Usd =
    params.feesCollected1 === 0
      ? 0
      : params.token1UsdPrice === null
        ? null
        : params.feesCollected1 * params.token1UsdPrice;
  const feesValueUsd =
    feesCollected0Usd === null || feesCollected1Usd === null
      ? null
      : feesCollected0Usd + feesCollected1Usd;
  const usdPriceSource =
    params.token0UsdPrice !== null || params.token1UsdPrice !== null ? "coingecko" : null;

  return { feesCollected0Usd, feesCollected1Usd, feesValueUsd, usdPriceSource };
}

export async function getPnLView(
  config: Config,
  tokenId?: string,
  rawPositions?: PositionData[],
): Promise<PnLView[]> {
  const client = createClient(config);
  const lifecycleContext = await createPositionLifecycleContext(config, { includeLatestBlock: true });

  const positions =
    rawPositions ??
    (await getAllPositions(client, config.contracts.positionManager, config.wallet));

  if (positions.length === 0) {
    return [];
  }

  const filteredPositions = tokenId
    ? positions.filter((p) => p.tokenId.toString() === tokenId)
    : positions;

  if (filteredPositions.length === 0) {
    throw new NotFoundError(`Position #${tokenId} not found.`);
  }

  const result: PnLView[] = [];

  for (const pos of filteredPositions) {
    const posConfig = config.positions?.[pos.tokenId.toString()];
    if (!posConfig) {
      console.warn(
        `[lp-tracker] Position ${pos.tokenId.toString()} found on-chain but missing from config.positions — consider adding it`,
      );
    }
    const lifecycle = await resolvePositionLifecycle(lifecycleContext, pos, {
      entryNotFound: "skip",
    });
    if (lifecycle.status === "rpc_error") {
      console.error(
        `[lp-tracker] RPC error discovering ${lifecycle.stage} event for position ${pos.tokenId.toString()}:`,
        lifecycle.error,
      );
      continue;
    }
    if (lifecycle.status === "skip") {
      continue;
    }

    const { facts } = lifecycle;
    const { token0Info, token1Info, storedPos, closeBlock } = facts;

    // Calculate full P&L
    const pnl = calculateFullPnL({
      entryAmount0Raw: facts.entryAmount0,
      entryAmount1Raw: facts.entryAmount1,
      exitAmount0Raw: facts.exitAmount0,
      exitAmount1Raw: facts.exitAmount1,
      feesCollected0Raw: facts.totalFees0,
      feesCollected1Raw: facts.totalFees1,
      entrySqrtPriceX96: facts.entrySqrtPriceX96,
      exitSqrtPriceX96: facts.exitSqrtPriceX96,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: facts.entryLiquidity,
      decimals0: token0Info.decimals,
      decimals1: token1Info.decimals,
    });

    const t0sym = token0Info.symbol;
    const t1sym = token1Info.symbol;
    const token0PriceKey = pos.token0.toLowerCase();
    const token1PriceKey = pos.token1.toLowerCase();
    let token0UsdPrice: number | null = null;
    let token1UsdPrice: number | null = null;

    if (closeBlock !== null) {
      // Closed position: use historical USD price at close time
      if (storedPos?.close_usd_price0 != null && storedPos?.close_usd_price1 != null) {
        // Fast path: prices already persisted in DB
        token0UsdPrice = storedPos.close_usd_price0;
        token1UsdPrice = storedPos.close_usd_price1;
      } else {
        // Slow path: fetch historical price at close block timestamp
        try {
          const block = await client.getBlock({ blockNumber: BigInt(closeBlock) });
          const isoTimestamp = new Date(Number(block.timestamp * 1000n)).toISOString();
          [token0UsdPrice, token1UsdPrice] = await Promise.all([
            getHistoricalPrice(config, t0sym, isoTimestamp, "usd"),
            getHistoricalPrice(config, t1sym, isoTimestamp, "usd"),
          ]);
          // Persist so future calls take the fast path (COALESCE in DB prevents overwriting)
          sqlitePositionStore.persistCloseUsdPrices({
            pos,
            tokens: { token0Info, token1Info },
            entry: {
              blockNumber:
                facts.entryBlock != null
                  ? facts.entryBlock
                  : storedPos?.entry_block != null
                    ? BigInt(storedPos.entry_block)
                    : undefined,
              amount0: facts.entryAmount0,
              amount1: facts.entryAmount1,
              liquidity: facts.entryLiquidity,
              sqrtPriceX96: facts.entrySqrtPriceX96,
            },
            closeBlock,
            closeUsdPrice0: token0UsdPrice,
            closeUsdPrice1: token1UsdPrice,
          });
        } catch {
          // Graceful degradation: leave prices as null
        }
        // CoinGecko historical data can lag 1-2 days for recent closes. Fill any
        // missing side from live prices so partial historical gaps don't hide USD fees.
        if (token0UsdPrice === null || token1UsdPrice === null) {
          try {
            const usdPrices = await getUsdPrices(config, [
              { symbol: t0sym, address: pos.token0 },
              { symbol: t1sym, address: pos.token1 },
            ]);
            token0UsdPrice ??= usdPrices[token0PriceKey] ?? null;
            token1UsdPrice ??= usdPrices[token1PriceKey] ?? null;
          } catch {
            // Live fallback is also optional.
          }
        }
      }
    } else {
      // Active position (or closed without a recorded close_block): use live prices
      try {
        const usdPrices = await getUsdPrices(config, [
          { symbol: t0sym, address: pos.token0 },
          { symbol: t1sym, address: pos.token1 },
        ]);
        token0UsdPrice = usdPrices[token0PriceKey] ?? null;
        token1UsdPrice = usdPrices[token1PriceKey] ?? null;
      } catch {
        // Live USD pricing is optional; token1-denominated P&L must still succeed.
      }
    }

    const { feesCollected0Usd, feesCollected1Usd, feesValueUsd, usdPriceSource } =
      calculateUsdFeeIncome({
        feesCollected0: pnl.feesCollected0,
        feesCollected1: pnl.feesCollected1,
        token0UsdPrice,
        token1UsdPrice,
      });

    // Pending Earnings: only the currently uncollected fees (for active positions).
    // For closed positions pendingFees0/1 stay 0n (nothing left to collect).
    const pendingFees0Human = Number(facts.pendingFees0) / 10 ** token0Info.decimals;
    const pendingFees1Human = Number(facts.pendingFees1) / 10 ** token1Info.decimals;
    const pendingFeesValueInToken1 = pendingFees0Human * pnl.exitPrice + pendingFees1Human;
    const pendingFeesValueUsd =
      token0UsdPrice !== null && token1UsdPrice !== null
        ? pendingFees0Human * token0UsdPrice + pendingFees1Human * token1UsdPrice
        : null;

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${t0sym}/${t1sym}`,
      token0Symbol: t0sym,
      token1Symbol: t1sym,
      status: facts.status,
      entryPrice: pnl.entryPrice,
      exitPrice: pnl.exitPrice,
      priceChangePercent: (pnl.exitPrice - pnl.entryPrice) / pnl.entryPrice,
      entryAmount0: pnl.entryAmount0,
      entryAmount1: pnl.entryAmount1,
      exitAmount0: pnl.exitAmount0,
      exitAmount1: pnl.exitAmount1,
      feesCollected0: pnl.feesCollected0,
      feesCollected1: pnl.feesCollected1,
      feesCollected0Usd,
      feesCollected1Usd,
      feesValueUsd,
      token0UsdPrice,
      token1UsdPrice,
      usdPriceSource,
      feesValueInToken1: pnl.feesValue,
      pendingFeesValueInToken1,
      pendingFeesValueUsd,
      entryValueInToken1: pnl.entryValue,
      exitValueInToken1: pnl.exitValue,
      holdValueInToken1: pnl.holdValue,
      absolutePnlInToken1: pnl.absolutePnl,
      absolutePnlPercent: pnl.absolutePnlPercent,
      divergenceLossPercent: pnl.divergenceLoss,
      opportunityCostInToken1: pnl.opportunityCost,
      netVsHodlPercent: pnl.netVsHodl,
      priceLower: pnl.priceLower,
      priceUpper: pnl.priceUpper,
    });
  }

  return result;
}
