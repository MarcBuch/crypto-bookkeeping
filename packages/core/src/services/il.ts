import type { Config } from "../config.js";
import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import { getPoolAddress, getPoolState, getTickData, getTokenInfo } from "../chain/pools.js";
import { findOpenEvent, findCloseEvent, getPoolPriceAtBlock } from "../chain/events.js";
import {
  calculateDivergenceLoss,
  calculateFeeGrowthInside,
  calculateUnclaimedFees,
  deriveEntryPriceFromAmounts,
  getTokenAmounts,
  sqrtPriceX96ToPrice,
} from "../math/divergence-loss.js";
import { upsertPosition, getPosition } from "../db/store.js";
import { NotFoundError } from "./errors.js";

export interface ILView {
  tokenId: string;
  pair: string;
  token0Symbol: string;
  token1Symbol: string;
  status: "active" | "closed";
  entryPrice: number;
  currentPrice: number;
  priceLower: number;
  priceUpper: number;
  divergenceLossPercent: number;
  valueLpInToken1: number;
  valueHoldInToken1: number;
  fees0: number;
  fees1: number;
  feesValueInToken1: number;
  netVsHodlPercent: number;
  netVsHodlInToken1: number;
}

export async function getILView(config: Config, tokenId?: string): Promise<ILView[]> {
  const client = createClient(config);

  const positions = await getAllPositions(client, config.contracts.positionManager, config.wallet);

  if (positions.length === 0) {
    return [];
  }

  const filteredPositions = tokenId
    ? positions.filter((p) => p.tokenId.toString() === tokenId)
    : positions;

  if (filteredPositions.length === 0) {
    throw new NotFoundError(`Position #${tokenId} not found.`);
  }

  const result: ILView[] = [];

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
    const posConfigIL = config.positions?.[pos.tokenId.toString()];

    // Get entry price
    let entrySqrtPriceX96: bigint;
    let entryAmount0 = 0n;
    let entryAmount1 = 0n;
    const storedPos = getPosition(pos.tokenId.toString());

    if (storedPos?.entry_sqrt_price_x96) {
      entrySqrtPriceX96 = BigInt(storedPos.entry_sqrt_price_x96);
      entryAmount0 = BigInt(storedPos.entry_amount0 || "0");
      entryAmount1 = BigInt(storedPos.entry_amount1 || "0");
    } else {
      // Need to find entry - run event scan
      const openEvent = await findOpenEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfigIL?.openTx,
      );

      if (openEvent) {
        entryAmount0 = openEvent.amount0;
        entryAmount1 = openEvent.amount1;
        // Derive entry price from actual deposit amounts (most accurate)
        entrySqrtPriceX96 = deriveEntryPriceFromAmounts(
          openEvent.amount0,
          openEvent.amount1,
          openEvent.liquidity,
          pos.tickLower,
          pos.tickUpper,
        );

        // Store for future use
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
        // Could not find entry — skip this position
        continue;
      }
    }

    // Determine current/exit sqrtPriceX96
    let currentSqrtPriceX96 = poolState.sqrtPriceX96;
    let exitAmount0 = 0n;
    let exitAmount1 = 0n;

    if (isActive) {
      const currentAmounts = getTokenAmounts(
        pos.liquidity,
        poolState.sqrtPriceX96,
        pos.tickLower,
        pos.tickUpper,
      );
      exitAmount0 = currentAmounts.amount0;
      exitAmount1 = currentAmounts.amount1;
    } else {
      // Closed: find close event — start from entry_block to avoid scanning from block 0
      const entryBlockIL = storedPos?.entry_block ? BigInt(storedPos.entry_block) : undefined;
      const closeEvent = await findCloseEvent(
        client,
        config.contracts.positionManager,
        pos.tokenId,
        config.wallet,
        posConfigIL?.closeTx,
        entryBlockIL,
      );
      if (closeEvent) {
        exitAmount0 = closeEvent.amount0;
        exitAmount1 = closeEvent.amount1;
        const closePrice = await getPoolPriceAtBlock(client, poolAddress, closeEvent.blockNumber);
        if (closePrice) currentSqrtPriceX96 = closePrice.sqrtPriceX96;
      }
    }

    // Calculate DL
    const dlResult = calculateDivergenceLoss(
      pos.liquidity > 0n ? pos.liquidity : BigInt(storedPos?.entry_sqrt_price_x96 ? 1 : 1),
      pos.tickLower,
      pos.tickUpper,
      entrySqrtPriceX96,
      currentSqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );

    // For closed positions, override with actual amounts
    const exitPrice = sqrtPriceX96ToPrice(
      currentSqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );
    const entryAmt0H = Number(entryAmount0) / 10 ** token0Info.decimals;
    const entryAmt1H = Number(entryAmount1) / 10 ** token1Info.decimals;
    const exitAmt0H = Number(exitAmount0) / 10 ** token0Info.decimals;
    const exitAmt1H = Number(exitAmount1) / 10 ** token1Info.decimals;

    const valueLp = exitAmt0H * exitPrice + exitAmt1H;
    const valueHold = entryAmt0H * exitPrice + entryAmt1H;

    const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

    // Calculate fees
    let fees0 = 0;
    let fees1 = 0;
    if (isActive) {
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
    }

    const feesValue = fees0 * exitPrice + fees1;
    const netVsHodl = valueHold > 0 ? (valueLp + feesValue - valueHold) / valueHold : 0;

    const priceLower = 1.0001 ** pos.tickLower * 10 ** (token0Info.decimals - token1Info.decimals);
    const priceUpper = 1.0001 ** pos.tickUpper * 10 ** (token0Info.decimals - token1Info.decimals);

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${token0Info.symbol}/${token1Info.symbol}`,
      token0Symbol: token0Info.symbol,
      token1Symbol: token1Info.symbol,
      status: isActive ? "active" : "closed",
      entryPrice: dlResult.entryPrice,
      currentPrice: exitPrice,
      priceLower,
      priceUpper,
      divergenceLossPercent: divergenceLoss,
      valueLpInToken1: valueLp,
      valueHoldInToken1: valueHold,
      fees0,
      fees1,
      feesValueInToken1: feesValue,
      netVsHodlPercent: netVsHodl,
      netVsHodlInToken1: valueLp + feesValue - valueHold,
    });
  }

  return result;
}
