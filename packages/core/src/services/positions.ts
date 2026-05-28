import type { Config } from "../config.js";
import { createClient } from "../chain/client.js";
import { getAllPositions } from "../chain/positions.js";
import { getPoolAddress, getPoolState, getTokenInfo } from "../chain/pools.js";
import { getTokenAmounts, sqrtPriceX96ToPrice } from "../math/divergence-loss.js";

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

export async function getPositionsView(config: Config): Promise<PositionView[]> {
  const client = createClient(config);

  const positions = await getAllPositions(
    client,
    config.contracts.positionManager,
    config.wallet
  );

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
      pos.fee
    );

    const poolState = await getPoolState(client, poolAddress);

    const currentAmounts = getTokenAmounts(
      pos.liquidity,
      poolState.sqrtPriceX96,
      pos.tickLower,
      pos.tickUpper
    );

    const priceLower =
      1.0001 ** pos.tickLower *
      10 ** (token0Info.decimals - token1Info.decimals);
    const priceUpper =
      1.0001 ** pos.tickUpper *
      10 ** (token0Info.decimals - token1Info.decimals);

    const currentPrice = sqrtPriceX96ToPrice(
      poolState.sqrtPriceX96,
      token0Info.decimals,
      token1Info.decimals
    );

    const inRange =
      poolState.tick >= pos.tickLower && poolState.tick < pos.tickUpper;
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
