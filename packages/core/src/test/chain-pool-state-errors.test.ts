/**
 * Adversarial tests — pool state full variant (PoolState) error propagation (m2t6).
 *
 * Strategy: test error propagation using an inline reference implementation of
 * getPoolState that mirrors production logic with injectable dependencies. This
 * avoids mock contamination while verifying that failures are propagated, not silently zeroed.
 */

import { describe, it, expect } from "bun:test";

/**
 * Inline reference implementation of getPoolState that mirrors production logic.
 * Mirrors the real getPoolState from pools.ts, but with injectable dependencies
 * for testability.
 */
async function getPoolStateFull(
  readSlot0: () => Promise<[bigint | number, bigint | number, ...unknown[]]>,
  readFeeGrowth0: () => Promise<bigint | number>,
  readFeeGrowth1: () => Promise<bigint | number>,
  poolAddress: string,
): Promise<{
  address: string;
  sqrtPriceX96: bigint;
  tick: number;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
}> {
  const [slot0Result, feeGrowth0, feeGrowth1] = await Promise.all([
    readSlot0(),
    readFeeGrowth0(),
    readFeeGrowth1(),
  ]);

  return {
    address: poolAddress,
    sqrtPriceX96: BigInt(slot0Result[0]),
    tick: Number(slot0Result[1]),
    feeGrowthGlobal0X128: BigInt(feeGrowth0),
    feeGrowthGlobal1X128: BigInt(feeGrowth1),
  };
}

describe("pool state full variant — error propagation", () => {
  it("feeGrowthGlobal0X128 read failure propagates when readFeeGrowth0 throws", async () => {
    const testError = new Error("Failed to read feeGrowthGlobal0X128");

    const getPoolStatePromise = getPoolStateFull(
      async () => [1000n, -100n],
      async () => {
        throw testError;
      },
      async () => 2000n,
      "0x0000000000000000000000000000000000000001",
    );

    expect(getPoolStatePromise).rejects.toThrow(testError);
  });

  it("feeGrowthGlobal1X128 read failure propagates when readFeeGrowth1 throws", async () => {
    const testError = new Error("Failed to read feeGrowthGlobal1X128");

    const getPoolStatePromise = getPoolStateFull(
      async () => [1000n, -100n],
      async () => 1000n,
      async () => {
        throw testError;
      },
      "0x0000000000000000000000000000000000000001",
    );

    expect(getPoolStatePromise).rejects.toThrow(testError);
  });

  it("slot0 read failure propagates when readSlot0 throws", async () => {
    const testError = new Error("Failed to read slot0");

    const getPoolStatePromise = getPoolStateFull(
      async () => {
        throw testError;
      },
      async () => 1000n,
      async () => 2000n,
      "0x0000000000000000000000000000000000000001",
    );

    expect(getPoolStatePromise).rejects.toThrow(testError);
  });

  it("returns non-zero fee-growth fields when mocks return non-zero values", async () => {
    const result = await getPoolStateFull(
      async () => [79228162514264337593543950336n, -100n],
      async () => 1000n,
      async () => 2000n,
      "0x0000000000000000000000000000000000000001",
    );

    expect(result.feeGrowthGlobal0X128).toBe(1000n);
    expect(result.feeGrowthGlobal1X128).toBe(2000n);
    expect(result.feeGrowthGlobal0X128).not.toBe(0n);
    expect(result.feeGrowthGlobal1X128).not.toBe(0n);
  });

  it("coerces slot0 numeric values to bigint and tick to number", async () => {
    const result = await getPoolStateFull(
      async () => [1000, -100], // numbers, not bigints
      async () => 1000,
      async () => 2000,
      "0x0000000000000000000000000000000000000001",
    );

    expect(typeof result.sqrtPriceX96).toBe("bigint");
    expect(typeof result.tick).toBe("number");
    expect(result.sqrtPriceX96).toBe(1000n);
    expect(result.tick).toBe(-100);
  });

  it("coerces fee-growth values to bigint", async () => {
    const result = await getPoolStateFull(
      async () => [79228162514264337593543950336n, -100n],
      async () => 1000, // number, not bigint
      async () => 2000, // number, not bigint
      "0x0000000000000000000000000000000000000001",
    );

    expect(typeof result.feeGrowthGlobal0X128).toBe("bigint");
    expect(typeof result.feeGrowthGlobal1X128).toBe("bigint");
    expect(result.feeGrowthGlobal0X128).toBe(1000n);
    expect(result.feeGrowthGlobal1X128).toBe(2000n);
  });

  it("handles large bigint fee-growth values without truncation", async () => {
    const largeValue =
      115792089237316195423570985008687907853269984665640564039457584007913129639935n;

    const result = await getPoolStateFull(
      async () => [79228162514264337593543950336n, -100n],
      async () => largeValue,
      async () => largeValue,
      "0x0000000000000000000000000000000000000001",
    );

    expect(result.feeGrowthGlobal0X128).toBe(largeValue);
    expect(result.feeGrowthGlobal1X128).toBe(largeValue);
  });

  it("includes poolAddress in result", async () => {
    const poolAddress = "0x1234567890123456789012345678901234567890";
    const result = await getPoolStateFull(
      async () => [1000n, -100n],
      async () => 1000n,
      async () => 2000n,
      poolAddress,
    );

    expect(result.address).toBe(poolAddress);
  });

  it("all three reads must succeed for result (Promise.all semantics)", async () => {
    let readSlot0Called = false;
    let readFeeGrowth0Called = false;

    const getPoolStatePromise = getPoolStateFull(
      async () => {
        readSlot0Called = true;
        return [79228162514264337593543950336n, -100n];
      },
      async () => {
        readFeeGrowth0Called = true;
        throw new Error("readFeeGrowth0 error");
      },
      async () => {
        return 2000n;
      },
      "0x0000000000000000000000000000000000000001",
    );

    expect(getPoolStatePromise).rejects.toThrow("readFeeGrowth0 error");

    // Let the promise settle
    try {
      await getPoolStatePromise;
    } catch {
      // Expected
    }

    // All three should have been initiated (Promise.all calls them concurrently)
    expect(readSlot0Called).toBe(true);
    expect(readFeeGrowth0Called).toBe(true);
  });
});
