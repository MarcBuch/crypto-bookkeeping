/**
 * Adversarial tests — pool address cache key correctness (m2t2).
 *
 * Strategy: test `buildPoolCacheKey` as a pure exported function rather than
 * going through `getPoolAddress`. This makes the tests immune to bun:test's
 * mock.module live-binding contamination — other test files that mock
 * `../chain/pools.js` cannot affect a named export tested directly.
 */

import { describe, it, expect } from "bun:test";

import type { Address } from "viem";

import { buildPoolCacheKey } from "../chain/pools.js";

const T0A = "0xa000000000000000000000000000000000000001" as Address;
const T0B = "0xa000000000000000000000000000000000000002" as Address;
const T0C = "0xa000000000000000000000000000000000000003" as Address;

describe("poolAddressCache — key correctness", () => {
  it("same token0+token1+fee produces identical key on repeated calls", () => {
    const key1 = buildPoolCacheKey(T0A, T0B, 3000);
    const key2 = buildPoolCacheKey(T0A, T0B, 3000);
    expect(key1).toBe(key2);
  });

  it("different fee produces a different key", () => {
    const key500 = buildPoolCacheKey(T0A, T0B, 500);
    const key3000 = buildPoolCacheKey(T0A, T0B, 3000);
    expect(key500).not.toBe(key3000);
  });

  it("uppercase token address produces same key as lowercase (case-insensitive)", () => {
    const lower = "0xa100000000000000000000000000000000000000" as Address;
    const upper = "0xA100000000000000000000000000000000000000" as Address;
    const keyLower = buildPoolCacheKey(lower, T0B, 3000);
    const keyUpper = buildPoolCacheKey(upper, T0B, 3000);
    expect(keyLower).toBe(keyUpper);
  });

  it("swapped token0/token1 produces a different key", () => {
    const keyAB = buildPoolCacheKey(T0A, T0B, 3000);
    const keyBA = buildPoolCacheKey(T0B, T0A, 3000);
    expect(keyAB).not.toBe(keyBA);
  });

  it("key includes both token addresses and the fee", () => {
    const key = buildPoolCacheKey(T0A, T0B, 3000);
    expect(key).toContain(T0A.toLowerCase());
    expect(key).toContain(T0B.toLowerCase());
    expect(key).toContain("3000");
  });

  it("different token1 with same token0 and fee produces a different key", () => {
    const keyAB = buildPoolCacheKey(T0A, T0B, 3000);
    const keyAC = buildPoolCacheKey(T0A, T0C, 3000);
    expect(keyAB).not.toBe(keyAC);
  });
});
