import { createClient } from "../chain/client.js";
import { findOpenEvent, findCloseEvent, getPoolPriceAtBlock } from "../chain/events.js";
import { createHyperSyncClient, DEFAULT_HYPERSYNC_URL } from "../chain/hypersync.js";
import { getPoolAddress, getPoolState, getTickData, getTokenInfo } from "../chain/pools.js";
import { getAllPositions, type PositionData } from "../chain/positions.js";
import { withRetry } from "../chain/rpc.js";
import type { Config } from "../config.js";
import { upsertPosition, getPosition } from "../db/store.js";
import {
  calculateFeeGrowthInside,
  calculateUnclaimedFees,
  calculateFullPnL,
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
} from "../math/divergence-loss.js";
import { NotFoundError } from "./errors.js";
import { getHistoricalUsdPrice, getUsdPrices } from "./pricing.js";

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

  const hyperSyncClient = config.hyperSync?.apiToken
    ? createHyperSyncClient({
        url: config.hyperSync.url ?? DEFAULT_HYPERSYNC_URL,
        apiToken: config.hyperSync.apiToken,
      })
    : undefined;

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

  // logsFromBlock is the number of blocks to scan back (window size), matching
  // the events.ts windowBlocks parameter. undefined → events.ts uses its default.
  const logsWindowBlocks =
    config.logsFromBlock !== undefined && config.logsFromBlock !== null
      ? BigInt(config.logsFromBlock)
      : undefined;

  // Fetch latestBlock once to share across all position lookups
  const latestBlock = await withRetry(() => client.getBlockNumber());

  for (const pos of filteredPositions) {
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

    const poolState = await getPoolState(client, poolAddress);
    const isActive = pos.liquidity > 0n;

    // Find open event (entry amounts)
    let entryAmount0 = 0n;
    let entryAmount1 = 0n;
    let entryLiquidity = pos.liquidity;

    const posConfig = config.positions?.[pos.tokenId.toString()];
    if (!posConfig) {
      console.warn(
        `[lp-tracker] Position ${pos.tokenId.toString()} found on-chain but missing from config.positions — consider adding it`,
      );
    }
    const storedPos = getPosition(pos.tokenId.toString());
    const hasStoredEntry = storedPos?.entry_amount0 && storedPos.entry_amount0 !== "0";
    const hasStoredLiquidity = storedPos?.entry_liquidity && storedPos.entry_liquidity !== "0";

    if (posConfig?.openTx) {
      // Config fast path: resolve entry amounts from known tx hash
      const openResult = await findOpenEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfig.openTx,
        undefined, // fromBlock — let the window default apply
        logsWindowBlocks, // windowBlocks from config
        latestBlock,
        hyperSyncClient,
      );

      if (openResult.status === "rpc_error") {
        console.error(
          `[lp-tracker] RPC error discovering open event for position ${pos.tokenId.toString()}:`,
          openResult.error,
        );
        continue;
      }
      if (openResult.status === "found") {
        const openEvent = openResult.event;
        entryAmount0 = openEvent.amount0;
        entryAmount1 = openEvent.amount1;
        entryLiquidity = openEvent.liquidity;

        // Persist entry data + open_tx if not already stored
        if (!hasStoredEntry || !storedPos?.open_tx) {
          const entrySqrtPrice = deriveEntryPriceFromAmounts(
            entryAmount0,
            entryAmount1,
            entryLiquidity,
            pos.tickLower,
            pos.tickUpper,
          );
          upsertPosition({
            token_id: pos.tokenId.toString(),
            token0: pos.token0,
            token1: pos.token1,
            token0_symbol: token0Info.symbol,
            token1_symbol: token1Info.symbol,
            token0_decimals: token0Info.decimals,
            token1_decimals: token1Info.decimals,
            fee: pos.fee,
            tick_lower: pos.tickLower,
            tick_upper: pos.tickUpper,
            entry_sqrt_price_x96: entrySqrtPrice.toString(),
            entry_block: Number(openEvent.blockNumber),
            entry_amount0: entryAmount0.toString(),
            entry_amount1: entryAmount1.toString(),
            entry_liquidity: entryLiquidity.toString(),
            open_tx: openEvent.transactionHash,
          });
        }
      } else {
        // not_found — could not resolve entry from config tx — skip this position
        continue;
      }
    } else if (storedPos?.open_tx) {
      // DB fast path: open_tx already persisted, entry data is already in the DB
      entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
      entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
      if (hasStoredLiquidity) {
        entryLiquidity = BigInt(storedPos.entry_liquidity!);
      }
    } else if (hasStoredEntry && (hasStoredLiquidity || isActive)) {
      entryAmount0 = BigInt(storedPos!.entry_amount0!);
      entryAmount1 = BigInt(storedPos!.entry_amount1 || "0");
      if (hasStoredLiquidity) {
        entryLiquidity = BigInt(storedPos!.entry_liquidity!);
      }
    } else {
      // Slow path: scan chain for open event
      const openResult = await findOpenEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        undefined,
        undefined, // fromBlock — let the window default apply
        logsWindowBlocks, // windowBlocks from config
        latestBlock,
        hyperSyncClient,
      );

      if (openResult.status === "rpc_error") {
        console.error(
          `[lp-tracker] RPC error discovering open event for position ${pos.tokenId.toString()}:`,
          openResult.error,
        );
        continue;
      }
      if (openResult.status === "found") {
        const openEvent = openResult.event;
        entryAmount0 = openEvent.amount0;
        entryAmount1 = openEvent.amount1;
        entryLiquidity = openEvent.liquidity;

        // Store entry data + open_tx for future use
        const entrySqrtPrice = deriveEntryPriceFromAmounts(
          entryAmount0,
          entryAmount1,
          entryLiquidity,
          pos.tickLower,
          pos.tickUpper,
        );
        upsertPosition({
          token_id: pos.tokenId.toString(),
          token0: pos.token0,
          token1: pos.token1,
          token0_symbol: token0Info.symbol,
          token1_symbol: token1Info.symbol,
          token0_decimals: token0Info.decimals,
          token1_decimals: token1Info.decimals,
          fee: pos.fee,
          tick_lower: pos.tickLower,
          tick_upper: pos.tickUpper,
          entry_sqrt_price_x96: entrySqrtPrice.toString(),
          entry_block: Number(openEvent.blockNumber),
          entry_amount0: entryAmount0.toString(),
          entry_amount1: entryAmount1.toString(),
          entry_liquidity: entryLiquidity.toString(),
          open_tx: openEvent.transactionHash,
        });
      } else {
        // not_found — could not find entry — skip this position
        continue;
      }
    }

    // Get exit/current amounts and fees
    let exitAmount0 = 0n;
    let exitAmount1 = 0n;
    let feesCollected0 = 0n;
    let feesCollected1 = 0n;
    let exitSqrtPriceX96 = poolState.sqrtPriceX96;

    if (isActive) {
      // Active position: use current amounts
      const currentAmounts = getTokenAmounts(
        pos.liquidity,
        poolState.sqrtPriceX96,
        pos.tickLower,
        pos.tickUpper,
      );
      exitAmount0 = currentAmounts.amount0;
      exitAmount1 = currentAmounts.amount1;

      // Calculate uncollected fees
      try {
        const [tickLowerData, tickUpperData] = await Promise.all([
          getTickData(client, poolAddress, pos.tickLower),
          getTickData(client, poolAddress, pos.tickUpper),
        ]);

        const feeGrowthInside = calculateFeeGrowthInside(
          pos.tickLower,
          pos.tickUpper,
          poolState.tick,
          poolState.feeGrowthGlobal0X128,
          poolState.feeGrowthGlobal1X128,
          tickLowerData.feeGrowthOutside0X128,
          tickLowerData.feeGrowthOutside1X128,
          tickUpperData.feeGrowthOutside0X128,
          tickUpperData.feeGrowthOutside1X128,
        );

        const feeResult = calculateUnclaimedFees(
          pos.liquidity,
          pos.feeGrowthInside0LastX128,
          pos.feeGrowthInside1LastX128,
          feeGrowthInside.feeGrowthInside0X128,
          feeGrowthInside.feeGrowthInside1X128,
          pos.tokensOwed0,
          pos.tokensOwed1,
          token0Info.decimals,
          token1Info.decimals,
        );

        feesCollected0 = BigInt(Math.floor(feeResult.fees0 * 10 ** token0Info.decimals));
        feesCollected1 = BigInt(Math.floor(feeResult.fees1 * 10 ** token1Info.decimals));
      } catch {
        // Fees calculation may fail — leave as 0
      }
    } else {
      // Closed position: use cached exit data if available (m2t5 fast path)
      const hasCachedExit =
        storedPos?.close_tx && storedPos.exit_amount0 != null && !posConfig?.closeTx;

      if (hasCachedExit) {
        exitAmount0 = BigInt(storedPos!.exit_amount0!);
        exitAmount1 = BigInt(storedPos!.exit_amount1 ?? "0");
        feesCollected0 = BigInt(storedPos!.fees_collected0 ?? "0");
        feesCollected1 = BigInt(storedPos!.fees_collected1 ?? "0");
        // Use close_block price if available, otherwise fall back to current price
        if (storedPos!.close_block) {
          const closePrice = await getPoolPriceAtBlock(
            client,
            poolAddress,
            BigInt(storedPos!.close_block),
          );
          if (closePrice) {
            exitSqrtPriceX96 = closePrice.sqrtPriceX96;
          }
        }
      } else {
        // Slow path: find the close event on chain
        const entryBlock = storedPos?.entry_block ? BigInt(storedPos.entry_block) : undefined;
        const closeResult = await findCloseEvent(
          client,
          config.contracts.positionManager,
          pos.tokenId,
          config.wallet,
          posConfig?.closeTx,
          entryBlock, // explicit fromBlock when known — wins over window
          logsWindowBlocks, // windowBlocks fallback when entryBlock undefined
          latestBlock,
          hyperSyncClient,
        );

        if (closeResult.status === "rpc_error") {
          console.error(
            `[lp-tracker] RPC error discovering close event for position ${pos.tokenId.toString()}:`,
            closeResult.error,
          );
          continue;
        }
        if (closeResult.status === "found") {
          const closeEvent = closeResult.event;
          exitAmount0 = closeEvent.amount0;
          exitAmount1 = closeEvent.amount1;
          feesCollected0 = closeEvent.collectedFees0;
          feesCollected1 = closeEvent.collectedFees1;

          // Get pool price at close block for accurate exit price
          const closePrice = await getPoolPriceAtBlock(client, poolAddress, closeEvent.blockNumber);
          if (closePrice) {
            exitSqrtPriceX96 = closePrice.sqrtPriceX96;
          }

          // Persist close data for future fast-path use (m2t4)
          upsertPosition({
            token_id: pos.tokenId.toString(),
            token0: pos.token0,
            token1: pos.token1,
            token0_symbol: token0Info.symbol,
            token1_symbol: token1Info.symbol,
            token0_decimals: token0Info.decimals,
            token1_decimals: token1Info.decimals,
            fee: pos.fee,
            tick_lower: pos.tickLower,
            tick_upper: pos.tickUpper,
            entry_sqrt_price_x96: storedPos?.entry_sqrt_price_x96 ?? null,
            entry_block: storedPos?.entry_block ?? null,
            entry_amount0: entryAmount0.toString(),
            entry_amount1: entryAmount1.toString(),
            entry_liquidity: entryLiquidity.toString(),
            open_tx: storedPos?.open_tx ?? null,
            close_tx: closeEvent.transactionHash,
            exit_amount0: closeEvent.amount0.toString(),
            exit_amount1: closeEvent.amount1.toString(),
            fees_collected0: closeEvent.collectedFees0.toString(),
            fees_collected1: closeEvent.collectedFees1.toString(),
            close_block: Number(closeEvent.blockNumber),
          });
        }
        // If no close event found, continue with zeroed amounts and current price
      }
    }

    // Calculate full P&L
    const pnl = calculateFullPnL({
      entryAmount0Raw: entryAmount0,
      entryAmount1Raw: entryAmount1,
      exitAmount0Raw: exitAmount0,
      exitAmount1Raw: exitAmount1,
      feesCollected0Raw: feesCollected0,
      feesCollected1Raw: feesCollected1,
      exitSqrtPriceX96,
      tickLower: pos.tickLower,
      tickUpper: pos.tickUpper,
      liquidity: entryLiquidity,
      decimals0: token0Info.decimals,
      decimals1: token1Info.decimals,
    });

    const t0sym = token0Info.symbol;
    const t1sym = token1Info.symbol;
    const token0PriceKey = pos.token0.toLowerCase();
    const token1PriceKey = pos.token1.toLowerCase();
    let token0UsdPrice: number | null = null;
    let token1UsdPrice: number | null = null;

    if ((storedPos?.close_block ?? null) !== null) {
      // Closed position: use historical USD price at close time
      if (storedPos!.close_usd_price0 != null && storedPos!.close_usd_price1 != null) {
        // Fast path: prices already persisted in DB
        token0UsdPrice = storedPos!.close_usd_price0;
        token1UsdPrice = storedPos!.close_usd_price1;
      } else {
        // Slow path: fetch historical price at close block timestamp
        try {
          const block = await client.getBlock({ blockNumber: BigInt(storedPos!.close_block!) });
          const isoTimestamp = new Date(Number(block.timestamp * 1000n)).toISOString();
          [token0UsdPrice, token1UsdPrice] = await Promise.all([
            getHistoricalUsdPrice(config, t0sym, isoTimestamp),
            getHistoricalUsdPrice(config, t1sym, isoTimestamp),
          ]);
          // Persist so future calls take the fast path (COALESCE in DB prevents overwriting)
          upsertPosition({
            ...storedPos!,
            close_usd_price0: token0UsdPrice,
            close_usd_price1: token1UsdPrice,
          });
        } catch {
          // Graceful degradation: leave prices as null
        }
        // CoinGecko historical data can lag 1-2 days for recent closes. If both
        // historical prices are still null, fall back to live prices so recently
        // closed positions show USD fees instead of "USD unavailable".
        if (token0UsdPrice === null && token1UsdPrice === null) {
          try {
            const usdPrices = await getUsdPrices(config, [
              { symbol: t0sym, address: pos.token0 },
              { symbol: t1sym, address: pos.token1 },
            ]);
            token0UsdPrice = usdPrices[token0PriceKey] ?? null;
            token1UsdPrice = usdPrices[token1PriceKey] ?? null;
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

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${t0sym}/${t1sym}`,
      token0Symbol: t0sym,
      token1Symbol: t1sym,
      status: isActive ? "active" : "closed",
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
