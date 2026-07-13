import { createClient } from "../chain/client.js";
import { getAllPositions, type PositionData } from "../chain/positions.js";
import type { Config } from "../config.js";
import { sqlitePositionStore } from "../db/position-store.js";
import { NotFoundError } from "./errors.js";
import { calculateLpEconomics } from "./lp-economics.js";
import { createPositionLifecycleContext, resolvePositionLifecycle } from "./position-lifecycle.js";
import { getHistoricalPrice, getUsdPrices } from "./pricing.js";

export interface PnLView {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  openedAt: string | null;
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
  const pricedFeeLegs = [feesCollected0Usd, feesCollected1Usd].filter(
    (value): value is number => value !== null,
  );
  const feesValueUsd =
    pricedFeeLegs.length === 0 ? null : pricedFeeLegs.reduce((total, value) => total + value, 0);
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
  const lifecycleContext = await createPositionLifecycleContext(config, {
    includeLatestBlock: true,
  });

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
    let openedAt: string | null = null;

    if (facts.entryBlock != null) {
      try {
        const entryBlock = await client.getBlock({ blockNumber: facts.entryBlock });
        openedAt = new Date(Number(entryBlock.timestamp * 1000n)).toISOString();
      } catch {
        openedAt = null;
      }
    }

    const economics = calculateLpEconomics(facts);

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
        feesCollected0: economics.totalFees0,
        feesCollected1: economics.totalFees1,
        token0UsdPrice,
        token1UsdPrice,
      });
    const pendingFeesValueUsd =
      token0UsdPrice !== null && token1UsdPrice !== null
        ? economics.pendingFees0 * token0UsdPrice + economics.pendingFees1 * token1UsdPrice
        : null;

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${t0sym}/${t1sym}`,
      token0Symbol: t0sym,
      token1Symbol: t1sym,
      openedAt,
      status: facts.status,
      entryPrice: economics.entryPrice,
      exitPrice: economics.exitPrice,
      priceChangePercent: economics.priceChangePercent,
      entryAmount0: economics.entryAmount0,
      entryAmount1: economics.entryAmount1,
      exitAmount0: economics.exitAmount0,
      exitAmount1: economics.exitAmount1,
      feesCollected0: economics.totalFees0,
      feesCollected1: economics.totalFees1,
      feesCollected0Usd,
      feesCollected1Usd,
      feesValueUsd,
      token0UsdPrice,
      token1UsdPrice,
      usdPriceSource,
      feesValueInToken1: economics.totalFeesValueInToken1,
      pendingFeesValueInToken1: economics.pendingFeesValueInToken1,
      pendingFeesValueUsd,
      entryValueInToken1: economics.entryValueInToken1,
      exitValueInToken1: economics.exitValueInToken1,
      holdValueInToken1: economics.holdValueInToken1,
      absolutePnlInToken1: economics.absolutePnlInToken1,
      absolutePnlPercent: economics.absolutePnlPercent,
      divergenceLossPercent: economics.divergenceLossPercent,
      opportunityCostInToken1: economics.opportunityCostInToken1,
      netVsHodlPercent: economics.netVsHodlPercent,
      priceLower: economics.priceLower,
      priceUpper: economics.priceUpper,
    });
  }

  return result;
}
