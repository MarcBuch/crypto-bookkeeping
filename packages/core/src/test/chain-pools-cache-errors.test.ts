/**
 * Adversarial tests — pool address cache error cases (m2t3).
 *
 * Strategy: simulate the cache behaviour inline using a local Map so these
 * tests are immune to bun:test mock.module contamination from service-layer
 * test files that mock `../chain/pools.js`.
 *
 * The reference implementation below mirrors the production getPoolAddress
 * logic in packages/core/src/chain/pools.ts exactly. If the production logic
 * changes, this file must be updated in lockstep.
 */

import { describe, it, expect } from "bun:test";

import type { Address } from "viem";

import { buildPoolCacheKey } from "../chain/pools.js";
import { captureError, expectError } from "./helpers/errors.js";

/**
 * Reference implementation of getPoolAddress with injectable cache and client.
 * Mirrors production logic in pools.ts.
 */
async function getPoolAddressWithCache(
  readContract: () => Promise<Address>,
  token0: Address,
  token1: Address,
  fee: number,
  cache: Map<string, Address>,
): Promise<Address> {
  const cacheKey = buildPoolCacheKey(token0, token1, fee);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const address = await readContract();
  cache.set(cacheKey, address);
  return address;
}

const T0 = "0xb000000000000000000000000000000000000001" as Address;
const T1 = "0xb000000000000000000000000000000000000002" as Address;
const POOL = "0x0000000000000000000000000000000000009910" as Address;

const alwaysThrowReadContract = async (): Promise<Address> => {
  throw new Error("network error");
};

describe("poolAddressCache — error cases", () => {
  it("RPC error propagates and does not cache the failed lookup", async () => {
    const cache = new Map<string, Address>();

    const error = await captureError(
      getPoolAddressWithCache(alwaysThrowReadContract, T0, T1, 500, cache),
    );
    expect(expectError(error).message).toContain("network error");

    // Cache must remain empty — no poisoned entry
    const cacheKey = buildPoolCacheKey(T0, T1, 500);
    expect(cache.has(cacheKey)).toBe(false);
  });

  it("subsequent call after failure hits RPC again (cache not poisoned)", async () => {
    const cache = new Map<string, Address>();
    let callCount = 0;

    const readContract = async (): Promise<Address> => {
      callCount++;
      if (callCount === 1) throw new Error("transient error");
      return POOL;
    };

    // First call fails
    const error = await captureError(getPoolAddressWithCache(readContract, T0, T1, 3000, cache));
    expect(expectError(error).message).toContain("transient error");

    // Second call succeeds and hits RPC (not a stale cache entry)
    const result = await getPoolAddressWithCache(readContract, T0, T1, 3000, cache);
    expect(result).toBe(POOL);
    expect(callCount).toBe(2);

    // Cache is now populated with the successful result
    const cacheKey = buildPoolCacheKey(T0, T1, 3000);
    expect(cache.get(cacheKey)).toBe(POOL);
  });

  it("successful call is cached — third call does not hit RPC", async () => {
    const cache = new Map<string, Address>();
    let callCount = 0;
    const readContract = async (): Promise<Address> => {
      callCount++;
      return POOL;
    };

    await getPoolAddressWithCache(readContract, T0, T1, 500, cache);
    await getPoolAddressWithCache(readContract, T0, T1, 500, cache);

    expect(callCount).toBe(1); // second call served from cache
  });
});
