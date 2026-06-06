import { createClient } from "../chain/client.js";
import { createHyperSyncClient } from "../chain/hypersync.js";
import { findOpenEvent } from "../chain/events.js";
import { getPoolAddress, getPoolState, getTickData, getTokenInfo } from "../chain/pools.js";
import { getAllPositions } from "../chain/positions.js";
import type { Config } from "../config.js";
import { upsertPosition, getPosition, insertSnapshot } from "../db/store.js";
import {
  calculateFeeGrowthInside,
  calculateUnclaimedFees,
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
  sqrtPriceX96ToPrice,
} from "../math/divergence-loss.js";

const DEFAULT_HYPERSYNC_URL = "https://hyperliquid.hypersync.xyz";

export interface SnapshotResult {
  tokenId: string;
  saved: boolean;
  message: string;
}

export async function takeSnapshot(config: Config): Promise<SnapshotResult[]> {
  const client = createClient(config);

  const hyperSyncClient = config.hyperSync?.apiToken
    ? createHyperSyncClient({
        url: config.hyperSync.url ?? DEFAULT_HYPERSYNC_URL,
        apiToken: config.hyperSync.apiToken,
      })
    : undefined;

  const positions = await getAllPositions(client, config.contracts.positionManager, config.wallet);

  if (positions.length === 0) {
    return [];
  }

  const results: SnapshotResult[] = [];

  // Number of blocks to scan back when discovering events (window size).
  // undefined → findOpenEvent uses its 30-day default.
  const logsWindowBlocks =
    config.logsFromBlock !== undefined && config.logsFromBlock !== null
      ? BigInt(config.logsFromBlock)
      : undefined;

  for (const pos of positions) {
    // Skip positions with 0 liquidity (closed)
    if (pos.liquidity === 0n) {
      results.push({
        tokenId: pos.tokenId.toString(),
        saved: false,
        message: `Skipped position #${pos.tokenId} (closed)`,
      });
      continue;
    }

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

    // Get or determine entry price
    let entrySqrtPriceX96: bigint | null = null;
    let entryAmount0 = 0n;
    let entryAmount1 = 0n;

    const posConfigSnap = config.positions?.[pos.tokenId.toString()];
    const storedPos = getPosition(pos.tokenId.toString());
    if (storedPos?.entry_sqrt_price_x96) {
      entrySqrtPriceX96 = BigInt(storedPos.entry_sqrt_price_x96);
      entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
      entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
    } else {
      const openResult = await findOpenEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfigSnap?.openTx,
        undefined,
        logsWindowBlocks,
        undefined,
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
        entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
          openEvent.amount0,
          openEvent.amount1,
          openEvent.liquidity,
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
          entry_sqrt_price_x96: entrySqrtPriceX96.toString(),
          entry_block: Number(openEvent.blockNumber),
          entry_amount0: entryAmount0.toString(),
          entry_amount1: entryAmount1.toString(),
          entry_liquidity: openEvent.liquidity.toString(),
        });
      } else {
        // not_found — use current price as fallback (matching original behavior)
        entrySqrtPriceX96 = poolState.sqrtPriceX96;
        const currentAmounts = getTokenAmounts(
          pos.liquidity,
          poolState.sqrtPriceX96,
          pos.tickLower,
          pos.tickUpper,
        );
        entryAmount0 = currentAmounts.amount0;
        entryAmount1 = currentAmounts.amount1;
      }
    }

    // Calculate current state
    const currentAmounts = getTokenAmounts(
      pos.liquidity,
      poolState.sqrtPriceX96,
      pos.tickLower,
      pos.tickUpper,
    );

    const exitPrice = sqrtPriceX96ToPrice(
      poolState.sqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );
    const entryAmt0H = Number(entryAmount0) / 10 ** token0Info.decimals;
    const entryAmt1H = Number(entryAmount1) / 10 ** token1Info.decimals;
    const curAmt0H = Number(currentAmounts.amount0) / 10 ** token0Info.decimals;
    const curAmt1H = Number(currentAmounts.amount1) / 10 ** token1Info.decimals;

    const valueLp = curAmt0H * exitPrice + curAmt1H;
    const valueHold = entryAmt0H * exitPrice + entryAmt1H;
    const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

    // Calculate fees
    let fees0 = 0;
    let fees1 = 0;
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

      fees0 = feeResult.fees0;
      fees1 = feeResult.fees1;
    } catch {
      // Fees calculation may fail — leave as 0
    }

    const feesValue = fees0 * exitPrice + fees1;
    const netPnl = valueLp - valueHold + feesValue;

    // Store snapshot
    insertSnapshot({
      token_id: pos.tokenId.toString(),
      timestamp: new Date().toISOString(),
      liquidity: pos.liquidity.toString(),
      current_sqrt_price_x96: poolState.sqrtPriceX96.toString(),
      current_tick: poolState.tick,
      current_amount0: curAmt0H.toString(),
      current_amount1: curAmt1H.toString(),
      entry_amount0: entryAmt0H.toString(),
      entry_amount1: entryAmt1H.toString(),
      value_lp: valueLp,
      value_hold: valueHold,
      divergence_loss: divergenceLoss,
      fees0,
      fees1,
      fees_value: feesValue,
      net_pnl: netPnl,
    });

    results.push({
      tokenId: pos.tokenId.toString(),
      saved: true,
      message: `Snapshot saved for #${pos.tokenId} (${token0Info.symbol}/${token1Info.symbol}) - DL: ${(divergenceLoss * 100).toFixed(4)}%`,
    });
  }

  return results;
}
