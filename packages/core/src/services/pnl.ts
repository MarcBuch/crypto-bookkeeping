import type { Config } from "../config.js";
import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import { getPoolAddress, getPoolState, getTickData, getTokenInfo } from "../chain/pools.js";
import { findOpenEvent, findCloseEvent, getPoolPriceAtBlock } from "../chain/events.js";
import {
  calculateFeeGrowthInside,
  calculateUnclaimedFees,
  calculateFullPnL,
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
} from "../math/divergence-loss.js";
import { upsertPosition, getPosition } from "../db/store.js";
import { NotFoundError } from "./errors.js";

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

export async function getPnLView(config: Config, tokenId?: string): Promise<PnLView[]> {
  const client = createClient(config);

  const positions = await getAllPositions(
    client,
    config.contracts.positionManager,
    config.wallet
  );

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
    const [token0Info, token1Info] = await Promise.all([
      getTokenInfo(client, pos.token0),
      getTokenInfo(client, pos.token1),
    ]);

    const poolAddress = await getPoolAddress(
      client,
      config.contracts.factory,
      pos.token0,
      pos.token1,
      pos.fee
    );

    const poolState = await getPoolState(client, poolAddress);
    const isActive = pos.liquidity > 0n;

    // Find open event (entry amounts)
    let entryAmount0 = 0n;
    let entryAmount1 = 0n;
    let entryLiquidity = pos.liquidity;

    const posConfig = config.positions?.[pos.tokenId.toString()];
    const storedPos = getPosition(pos.tokenId.toString());
    const hasStoredEntry = storedPos?.entry_amount0 && storedPos.entry_amount0 !== "0";
    const hasStoredLiquidity = storedPos?.entry_liquidity && storedPos.entry_liquidity !== "0";
    if (hasStoredEntry && (hasStoredLiquidity || isActive)) {
      entryAmount0 = BigInt(storedPos!.entry_amount0!);
      entryAmount1 = BigInt(storedPos!.entry_amount1 || "0");
      if (hasStoredLiquidity) {
        entryLiquidity = BigInt(storedPos!.entry_liquidity!);
      }
    } else {
      const openEvent = await findOpenEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfig?.openTx
      );

      if (openEvent) {
        entryAmount0 = openEvent.amount0;
        entryAmount1 = openEvent.amount1;
        entryLiquidity = openEvent.liquidity;

        // Store for future use
        const entrySqrtPrice = deriveEntryPriceFromAmounts(
          entryAmount0,
          entryAmount1,
          entryLiquidity,
          pos.tickLower,
          pos.tickUpper
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
        });
      } else {
        // Could not find entry — skip this position
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
        pos.tickUpper
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
          tickUpperData.feeGrowthOutside1X128
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
          token1Info.decimals
        );

        feesCollected0 = BigInt(Math.floor(feeResult.fees0 * 10 ** token0Info.decimals));
        feesCollected1 = BigInt(Math.floor(feeResult.fees1 * 10 ** token1Info.decimals));
      } catch (e) {
        // Fees calculation may fail — leave as 0
      }
    } else {
      // Closed position: find the close event
      const entryBlock = storedPos?.entry_block
        ? BigInt(storedPos.entry_block)
        : undefined;
      const closeEvent = await findCloseEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfig?.closeTx,
        entryBlock
      );

      if (closeEvent) {
        exitAmount0 = closeEvent.amount0;
        exitAmount1 = closeEvent.amount1;
        feesCollected0 = closeEvent.collectedFees0;
        feesCollected1 = closeEvent.collectedFees1;

        // Get pool price at close block for accurate exit price
        const closePrice = await getPoolPriceAtBlock(
          client,
          poolAddress,
          closeEvent.blockNumber
        );
        if (closePrice) {
          exitSqrtPriceX96 = closePrice.sqrtPriceX96;
        }
      }
      // If no close event found, continue with zeroed amounts and current price
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
