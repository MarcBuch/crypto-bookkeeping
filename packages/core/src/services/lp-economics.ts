import type { TokenInfo } from "../chain/pools.js";
import type { PositionData } from "../chain/positions.js";
import {
  deriveEntryPriceFromAmounts,
  sqrtPriceX96ToPrice,
  tickToPrice,
} from "../math/divergence-loss.js";

export interface LpEconomicsFacts {
  pos: Pick<PositionData, "tickLower" | "tickUpper">;
  token0Info: Pick<TokenInfo, "decimals">;
  token1Info: Pick<TokenInfo, "decimals">;
  entryAmount0: bigint;
  entryAmount1: bigint;
  entryLiquidity: bigint;
  entrySqrtPriceX96?: bigint;
  exitAmount0: bigint;
  exitAmount1: bigint;
  exitSqrtPriceX96: bigint;
  pendingFees0: bigint;
  pendingFees1: bigint;
  totalFees0: bigint;
  totalFees1: bigint;
}

export interface LpEconomicsResult {
  entryAmount0: number;
  entryAmount1: number;
  exitAmount0: number;
  exitAmount1: number;
  pendingFees0: number;
  pendingFees1: number;
  totalFees0: number;
  totalFees1: number;
  entryPrice: number;
  exitPrice: number;
  priceChangePercent: number;
  entryValueInToken1: number;
  exitValueInToken1: number;
  holdValueInToken1: number;
  pendingFeesValueInToken1: number;
  totalFeesValueInToken1: number;
  absolutePnlInToken1: number;
  absolutePnlPercent: number;
  divergenceLossPercent: number;
  opportunityCostInToken1: number;
  netVsHodlInToken1: number;
  netVsHodlPercent: number;
  priceLower: number;
  priceUpper: number;
}

export function calculateLpEconomics(facts: LpEconomicsFacts): LpEconomicsResult {
  const decimals0 = facts.token0Info.decimals;
  const decimals1 = facts.token1Info.decimals;
  const entryAmount0 = toHumanAmount(facts.entryAmount0, decimals0);
  const entryAmount1 = toHumanAmount(facts.entryAmount1, decimals1);
  const exitAmount0 = toHumanAmount(facts.exitAmount0, decimals0);
  const exitAmount1 = toHumanAmount(facts.exitAmount1, decimals1);
  const pendingFees0 = toHumanAmount(facts.pendingFees0, decimals0);
  const pendingFees1 = toHumanAmount(facts.pendingFees1, decimals1);
  const totalFees0 = toHumanAmount(facts.totalFees0, decimals0);
  const totalFees1 = toHumanAmount(facts.totalFees1, decimals1);
  const entrySqrtPriceX96 =
    facts.entrySqrtPriceX96 ??
    deriveEntryPriceFromAmounts(
      facts.entryAmount0,
      facts.entryAmount1,
      facts.entryLiquidity,
      facts.pos.tickLower,
      facts.pos.tickUpper,
    );
  const entryPrice = sqrtPriceX96ToPrice(entrySqrtPriceX96, decimals0, decimals1);
  const exitPrice = sqrtPriceX96ToPrice(facts.exitSqrtPriceX96, decimals0, decimals1);
  const entryValueInToken1 = entryAmount0 * entryPrice + entryAmount1;
  const exitValueInToken1 = exitAmount0 * exitPrice + exitAmount1;
  const holdValueInToken1 = entryAmount0 * exitPrice + entryAmount1;
  const pendingFeesValueInToken1 = pendingFees0 * exitPrice + pendingFees1;
  const totalFeesValueInToken1 = totalFees0 * exitPrice + totalFees1;
  const absolutePnlInToken1 = exitValueInToken1 + totalFeesValueInToken1 - entryValueInToken1;
  const divergenceLossPercent =
    holdValueInToken1 > 0 ? (exitValueInToken1 - holdValueInToken1) / holdValueInToken1 : 0;
  const opportunityCostInToken1 = holdValueInToken1 - exitValueInToken1;
  const netVsHodlInToken1 = exitValueInToken1 + totalFeesValueInToken1 - holdValueInToken1;
  const decimalAdjustment = 10 ** (decimals0 - decimals1);

  return {
    entryAmount0,
    entryAmount1,
    exitAmount0,
    exitAmount1,
    pendingFees0,
    pendingFees1,
    totalFees0,
    totalFees1,
    entryPrice,
    exitPrice,
    priceChangePercent: entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0,
    entryValueInToken1,
    exitValueInToken1,
    holdValueInToken1,
    pendingFeesValueInToken1,
    totalFeesValueInToken1,
    absolutePnlInToken1,
    absolutePnlPercent: entryValueInToken1 > 0 ? absolutePnlInToken1 / entryValueInToken1 : 0,
    divergenceLossPercent,
    opportunityCostInToken1,
    netVsHodlInToken1,
    netVsHodlPercent: holdValueInToken1 > 0 ? netVsHodlInToken1 / holdValueInToken1 : 0,
    priceLower: tickToPrice(facts.pos.tickLower) * decimalAdjustment,
    priceUpper: tickToPrice(facts.pos.tickUpper) * decimalAdjustment,
  };
}

function toHumanAmount(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
