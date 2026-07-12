import type { Address } from "viem";

import {
  calculateFeeGrowthInside,
  calculateUnclaimedFeesRaw,
} from "../math/divergence-loss.js";
import { factoryAbi, poolAbi, erc20Abi } from "./abis";
import type { Client } from "./client";
import { withRetry } from "./rpc";

type ReadContractClient = Pick<Client, "readContract">;

export interface Slot0 {
  address: Address;
  sqrtPriceX96: bigint;
  tick: number;
}

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
}

export interface TickData {
  liquidityGross: bigint;
  liquidityNet: bigint;
  feeGrowthOutside0X128: bigint;
  feeGrowthOutside1X128: bigint;
}

// Cache for token info to avoid repeated RPC calls
const tokenCache = new Map<string, TokenInfo>();

// Cache for pool addresses to avoid repeated RPC calls
const poolAddressCache = new Map<string, Address>();

/**
 * Build the cache key used to deduplicate getPoolAddress lookups.
 * Exported so tests can verify key semantics without going through the full
 * getPoolAddress call (which is mocked in service-layer tests).
 */
export function buildPoolCacheKey(token0: Address, token1: Address, fee: number): string {
  return `${token0.toLowerCase()}:${token1.toLowerCase()}:${fee}`;
}

export async function getPoolAddress(
  client: ReadContractClient,
  factory: Address,
  token0: Address,
  token1: Address,
  fee: number,
): Promise<Address> {
  const cacheKey = buildPoolCacheKey(token0, token1, fee);
  const cached = poolAddressCache.get(cacheKey);
  if (cached) return cached;

  const address = await withRetry(() =>
    client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
    }),
  );

  poolAddressCache.set(cacheKey, address);
  return address;
}

export async function getSlot0(client: ReadContractClient, poolAddress: Address): Promise<Slot0> {
  const slot0Result = await withRetry(() =>
    client.readContract({
      address: poolAddress,
      abi: poolAbi,
      functionName: "slot0",
    }),
  );

  return {
    address: poolAddress,
    sqrtPriceX96: slot0Result[0],
    tick: slot0Result[1],
  };
}

export async function getPoolState(
  client: ReadContractClient,
  poolAddress: Address,
): Promise<PoolState> {
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
    sqrtPriceX96: slot0Result[0],
    tick: slot0Result[1],
    feeGrowthGlobal0X128: feeGrowth0,
    feeGrowthGlobal1X128: feeGrowth1,
  };
}

export async function getTickData(
  client: ReadContractClient,
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
    liquidityGross: result[0],
    liquidityNet: result[1],
    feeGrowthOutside0X128: result[2],
    feeGrowthOutside1X128: result[3],
  };
}

/**
 * Compute unclaimed fees for a position.
 *
 * Fetches tick data for the position's lower and upper ticks, calculates
 * fee growth inside the range, and returns the unclaimed fees in human-readable
 * format (float, not bigint).
 *
 * On any error (RPC failure, calculation error, etc.), silently returns
 * { fees0: 0, fees1: 0 } to match the behavior of existing call sites.
 */
export async function computeUnclaimedFees(
  client: ReadContractClient,
  poolAddress: Address,
  pos: {
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  },
  poolState: PoolState,
  token0Decimals: number,
  token1Decimals: number,
): Promise<{ fees0: number; fees1: number }> {
  const feeResult = await computeUnclaimedFeesRaw(
    client,
    poolAddress,
    pos,
    poolState,
  );

  return {
    fees0: Number(feeResult.fees0) / 10 ** token0Decimals,
    fees1: Number(feeResult.fees1) / 10 ** token1Decimals,
  };
}

export async function computeUnclaimedFeesRaw(
  client: ReadContractClient,
  poolAddress: Address,
  pos: {
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  },
  poolState: PoolState,
): Promise<{ fees0: bigint; fees1: bigint }> {
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

    return calculateUnclaimedFeesRaw(
      pos.liquidity,
      pos.feeGrowthInside0LastX128,
      pos.feeGrowthInside1LastX128,
      feeGrowthInside.feeGrowthInside0X128,
      feeGrowthInside.feeGrowthInside1X128,
      pos.tokensOwed0,
      pos.tokensOwed1,
    );
  } catch {
    // Fees calculation may fail — leave as 0
    return { fees0: 0n, fees1: 0n };
  }
}

export async function getTokenInfo(
  client: ReadContractClient,
  tokenAddress: Address,
): Promise<TokenInfo> {
  const cached = tokenCache.get(tokenAddress.toLowerCase());
  if (cached) return cached;

  const [symbol, decimals] = await Promise.all([
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
  ]);

  const info: TokenInfo = {
    address: tokenAddress,
    symbol,
    decimals,
  };

  tokenCache.set(tokenAddress.toLowerCase(), info);
  return info;
}
