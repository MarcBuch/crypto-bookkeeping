import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import type { Config } from "../config.js";
import { sqrtPriceX96ToPrice } from "../math/divergence-loss.js";
import { NotFoundError } from "./errors.js";
import {
  createPositionLifecycleContext,
  resolvePositionLifecycle,
} from "./position-lifecycle.js";

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
  const lifecycleContext = await createPositionLifecycleContext(config, { includeLatestBlock: true });

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
    const lifecycle = await resolvePositionLifecycle(lifecycleContext, pos, {
      entryNotFound: "skip",
      requireEntrySqrtPriceX96: true,
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
    const { token0Info, token1Info } = facts;
    const entrySqrtPriceX96 = facts.entrySqrtPriceX96;

    if (entrySqrtPriceX96 == null) {
      continue;
    }

    const exitPrice = sqrtPriceX96ToPrice(
      facts.exitSqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals,
    );
    const entryAmt0H = Number(facts.entryAmount0) / 10 ** token0Info.decimals;
    const entryAmt1H = Number(facts.entryAmount1) / 10 ** token1Info.decimals;
    const exitAmt0H = Number(facts.currentAmount0) / 10 ** token0Info.decimals;
    const exitAmt1H = Number(facts.currentAmount1) / 10 ** token1Info.decimals;

    const valueLp = exitAmt0H * exitPrice + exitAmt1H;
    const valueHold = entryAmt0H * exitPrice + entryAmt1H;

    const divergenceLoss = valueHold > 0 ? (valueLp - valueHold) / valueHold : 0;

    // Calculate fees
    const fees0 = Number(facts.pendingFees0) / 10 ** token0Info.decimals;
    const fees1 = Number(facts.pendingFees1) / 10 ** token1Info.decimals;

    const feesValue = fees0 * exitPrice + fees1;
    const netVsHodl = valueHold > 0 ? (valueLp + feesValue - valueHold) / valueHold : 0;

    const priceLower = 1.0001 ** pos.tickLower * 10 ** (token0Info.decimals - token1Info.decimals);
    const priceUpper = 1.0001 ** pos.tickUpper * 10 ** (token0Info.decimals - token1Info.decimals);

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${token0Info.symbol}/${token1Info.symbol}`,
      token0Symbol: token0Info.symbol,
      token1Symbol: token1Info.symbol,
      status: facts.status,
      entryPrice: sqrtPriceX96ToPrice(entrySqrtPriceX96, token0Info.decimals, token1Info.decimals),
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
