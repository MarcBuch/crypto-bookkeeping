import type { Address } from "viem";

import { factoryAbi, poolAbi, erc20Abi } from "./abis";
import type { Client } from "./client";
import { withRetry } from "./rpc";

export interface PoolState {
  address: Address;
  sqrtPriceX96: bigint;
  tick: number;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
}

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  name: string;
}

export interface TickData {
  liquidityGross: bigint;
  liquidityNet: bigint;
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
}

// Cache for token info to avoid repeated RPC calls
const tokenCache = new Map<string, TokenInfo>();

export async function getPoolAddress(
  client: Client,
  factory: Address,
  token0: Address,
  token1: Address,
  fee: number,
): Promise<Address> {
  return withRetry(() =>
    client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
    }),
  );
}

export async function getPoolState(client: Client, poolAddress: Address): Promise<PoolState> {
  const [slot0Result, feeGrowth0, feeGrowth1] = await Promise.all([
    withRetry(() =>
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "slot0",
      }),
    ),
    withRetry(() =>
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "feeGrowthGlobal0X128",
      }),
    ),
    withRetry(() =>
      client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "feeGrowthGlobal1X128",
      }),
    ),
  ]);

  return {
    address: poolAddress,
    sqrtPriceX96: BigInt(slot0Result[0]),
    tick: Number(slot0Result[1]),
    feeGrowthGlobal0X128: BigInt(feeGrowth0),
    feeGrowthGlobal1X128: BigInt(feeGrowth1),
  };
}

export async function getTickData(
  client: Client,
  poolAddress: Address,
  tick: number,
): Promise<TickData> {
  const result = await withRetry(() =>
    client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "ticks",
      args: [tick],
    }),
  );

  return {
    liquidityGross: BigInt(result[0]),
    liquidityNet: BigInt(result[1]),
    feeGrowthOutside0X128: BigInt(result[2]),
    feeGrowthOutside1X128: BigInt(result[3]),
  };
}

export async function getTokenInfo(client: Client, tokenAddress: Address): Promise<TokenInfo> {
  const cached = tokenCache.get(tokenAddress.toLowerCase());
  if (cached) return cached;

  const [symbol, decimals, name] = await Promise.all([
    withRetry(() =>
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "symbol",
      }),
    ),
    withRetry(() =>
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ),
    withRetry(() =>
      client.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "name",
      }),
    ),
  ]);

  const info: TokenInfo = {
    address: tokenAddress,
    symbol,
    decimals: Number(decimals),
    name,
  };

  tokenCache.set(tokenAddress.toLowerCase(), info);
  return info;
}
