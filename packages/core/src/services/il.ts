import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import type { Config } from "../config.js";
import { NotFoundError } from "./errors.js";
import { calculateLpEconomics } from "./lp-economics.js";
import { createPositionLifecycleContext, resolvePositionLifecycle } from "./position-lifecycle.js";

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
  const lifecycleContext = await createPositionLifecycleContext(config, {
    includeLatestBlock: true,
  });

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
    const economics = calculateLpEconomics(facts);

    result.push({
      tokenId: pos.tokenId.toString(),
      pair: `${token0Info.symbol}/${token1Info.symbol}`,
      token0Symbol: token0Info.symbol,
      token1Symbol: token1Info.symbol,
      status: facts.status,
      entryPrice: economics.entryPrice,
      currentPrice: economics.exitPrice,
      priceLower: economics.priceLower,
      priceUpper: economics.priceUpper,
      divergenceLossPercent: economics.divergenceLossPercent,
      valueLpInToken1: economics.exitValueInToken1,
      valueHoldInToken1: economics.holdValueInToken1,
      fees0: economics.totalFees0,
      fees1: economics.totalFees1,
      feesValueInToken1: economics.totalFeesValueInToken1,
      netVsHodlPercent: economics.netVsHodlPercent,
      netVsHodlInToken1: economics.netVsHodlInToken1,
    });
  }

  return result;
}
