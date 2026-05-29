import type { Address } from "viem";
import type { Client } from "./client";
import { positionManagerAbi } from "./abis";
import { withRetry } from "./rpc";

export interface PositionData {
  tokenId: bigint;
  nonce: bigint;
  operator: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

export async function getPositionCount(
  client: Client,
  positionManager: Address,
  wallet: Address,
): Promise<number> {
  const balance = await withRetry(() =>
    client.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "balanceOf",
      args: [wallet],
    }),
  );
  return Number(balance);
}

export async function getTokenId(
  client: Client,
  positionManager: Address,
  wallet: Address,
  index: number,
): Promise<bigint> {
  return withRetry(() =>
    client.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "tokenOfOwnerByIndex",
      args: [wallet, BigInt(index)],
    }),
  );
}

export async function getPositionData(
  client: Client,
  positionManager: Address,
  tokenId: bigint,
): Promise<PositionData> {
  const result = await withRetry(() =>
    client.readContract({
      address: positionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [tokenId],
    }),
  );

  return {
    tokenId,
    nonce: BigInt(result[0]),
    operator: result[1],
    token0: result[2],
    token1: result[3],
    fee: Number(result[4]),
    tickLower: Number(result[5]),
    tickUpper: Number(result[6]),
    liquidity: BigInt(result[7]),
    feeGrowthInside0LastX128: BigInt(result[8]),
    feeGrowthInside1LastX128: BigInt(result[9]),
    tokensOwed0: BigInt(result[10]),
    tokensOwed1: BigInt(result[11]),
  };
}

export async function getAllPositions(
  client: Client,
  positionManager: Address,
  wallet: Address,
): Promise<PositionData[]> {
  const count = await getPositionCount(client, positionManager, wallet);
  console.log(`Found ${count} position(s) for wallet ${wallet}`);

  // Fetch all tokenIds in parallel, then all position data in parallel
  const indices = Array.from({ length: count }, (_, i) => i);
  const tokenIds = await Promise.all(
    indices.map((i) => getTokenId(client, positionManager, wallet, i)),
  );
  const positions = await Promise.all(
    tokenIds.map((tokenId) => getPositionData(client, positionManager, tokenId)),
  );

  return positions;
}
