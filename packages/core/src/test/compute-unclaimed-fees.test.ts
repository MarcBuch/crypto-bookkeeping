/**
 * Adversarial tests — computeUnclaimedFees (RPC failures and error swallowing) (m1t2).
 *
 * Strategy: test the REAL computeUnclaimedFees function from pools.ts by controlling
 * the client argument. The client's readContract method is what getTickData calls,
 * so we can make it throw to test error handling. This verifies that RPC failures
 * are caught and silently return { fees0: 0, fees1: 0 }, not propagated.
 */

import { describe, it, expect } from "bun:test";
import type { Address } from "viem";
import { computeUnclaimedFees } from "../chain/pools.js";

describe("computeUnclaimedFees — RPC failures and error swallowing", () => {
  // Test data
  const poolAddress = "0x0000000000000000000000000000000000000001" as Address;

  const tickLowerData = {
    liquidityGross: 1000000n,
    liquidityNet: 1000000n,
    feeGrowthOutside0X128: 50000n,
    feeGrowthOutside1X128: 100000n,
  };

  const tickUpperData = {
    liquidityGross: 1000000n,
    liquidityNet: -1000000n,
    feeGrowthOutside0X128: 50000n,
    feeGrowthOutside1X128: 100000n,
  };

  const position = {
    tickLower: -100,
    tickUpper: 100,
    liquidity: 1000000n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  };

  const poolState = {
    address: poolAddress,
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 1000n,
    feeGrowthGlobal1X128: 2000n,
  };

  // Mock client that returns valid tick data
  const successClient = {
    readContract: async () => {
      return [
        tickLowerData.liquidityGross,
        tickLowerData.liquidityNet,
        tickLowerData.feeGrowthOutside0X128,
        tickLowerData.feeGrowthOutside1X128,
      ];
    },
  };

  // Mock client that always throws
  const failingClient = {
    readContract: async () => {
      throw new Error("RPC error");
    },
  };

  // Mock client that throws on first call, succeeds on second
  const failOnFirstClient = {
    callCount: 0,
    readContract: async function () {
      this.callCount++;
      if (this.callCount === 1) {
        throw new Error("RPC failed: lower tick data");
      }
      return [
        tickUpperData.liquidityGross,
        tickUpperData.liquidityNet,
        tickUpperData.feeGrowthOutside0X128,
        tickUpperData.feeGrowthOutside1X128,
      ];
    },
  };

  // Mock client that throws on second call, succeeds on first
  const failOnSecondClient = {
    callCount: 0,
    readContract: async function () {
      this.callCount++;
      if (this.callCount === 2) {
        throw new Error("RPC failed: upper tick data");
      }
      return [
        tickLowerData.liquidityGross,
        tickLowerData.liquidityNet,
        tickLowerData.feeGrowthOutside0X128,
        tickLowerData.feeGrowthOutside1X128,
      ];
    },
  };

  // Mock client that throws non-Error string
  const failWithStringClient = {
    readContract: async () => {
      throw "timeout"; // Non-Error value
    },
  };

  it("happy path: both readContract calls succeed → fees computed correctly", async () => {
    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });

  it("lower tick readContract fails → Promise.all rejects → returns { fees0: 0, fees1: 0 }", async () => {
    const result = await computeUnclaimedFees(
      failOnFirstClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("upper tick readContract fails → Promise.all rejects → returns { fees0: 0, fees1: 0 }", async () => {
    const result = await computeUnclaimedFees(
      failOnSecondClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("both readContract calls fail → Promise.all rejects → returns { fees0: 0, fees1: 0 }", async () => {
    const result = await computeUnclaimedFees(
      failingClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("readContract throws non-Error value (string) → caught by catch block → returns { fees0: 0, fees1: 0 }", async () => {
    const result = await computeUnclaimedFees(
      failWithStringClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("returns exactly { fees0: 0, fees1: 0 } on error, not partial results", async () => {
    const result = await computeUnclaimedFees(
      failingClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(Object.keys(result).sort()).toEqual(["fees0", "fees1"]);
    expect(result.fees0).toBe(0);
    expect(result.fees1).toBe(0);
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
  });

  it("both tick data calls are initiated concurrently (Promise.all semantics)", async () => {
    let lowerCalled = false;
    let upperCalled = false;

    const concurrentClient = {
      callCount: 0,
      readContract: async function () {
        this.callCount++;
        if (this.callCount === 1) {
          lowerCalled = true;
          // Delay to ensure upper call is initiated before this throws
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("Lower tick failed");
        }
        upperCalled = true;
        return [
          tickUpperData.liquidityGross,
          tickUpperData.liquidityNet,
          tickUpperData.feeGrowthOutside0X128,
          tickUpperData.feeGrowthOutside1X128,
        ];
      },
    };

    const result = await computeUnclaimedFees(
      concurrentClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    // Both should have been initiated (Promise.all calls them concurrently)
    expect(lowerCalled).toBe(true);
    expect(upperCalled).toBe(true);
    // And error should be caught
    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("error does not propagate — function returns { fees0: 0, fees1: 0 }", async () => {
    const result = await computeUnclaimedFees(
      failingClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    // Should not throw, should return zero fees
    expect(result).toEqual({ fees0: 0, fees1: 0 });
  });

  it("happy path with zero liquidity → returns computed fees correctly", async () => {
    const zeroLiquidityPosition = {
      ...position,
      liquidity: 0n,
    };

    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      zeroLiquidityPosition,
      poolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
  });

  it("happy path with large liquidity → returns computed fees correctly", async () => {
    const largeLiquidityPosition = {
      ...position,
      liquidity: 1000000000000000n,
    };

    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      largeLiquidityPosition,
      poolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });
});

describe("computeUnclaimedFees — boundary values", () => {
  const poolAddress = "0x0000000000000000000000000000000000000001" as Address;

  const tickLowerData = {
    liquidityGross: 1000000n,
    liquidityNet: 1000000n,
    feeGrowthOutside0X128: 50000n,
    feeGrowthOutside1X128: 100000n,
  };

  const tickUpperData = {
    liquidityGross: 1000000n,
    liquidityNet: -1000000n,
    feeGrowthOutside0X128: 50000n,
    feeGrowthOutside1X128: 100000n,
  };

  const poolState = {
    address: poolAddress,
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 1000n,
    feeGrowthGlobal1X128: 2000n,
  };

  // Mock client that returns valid tick data
  const successClient = {
    readContract: async () => {
      return [
        tickLowerData.liquidityGross,
        tickLowerData.liquidityNet,
        tickLowerData.feeGrowthOutside0X128,
        tickLowerData.feeGrowthOutside1X128,
      ];
    },
  };

  it("liquidity = 0n with tokensOwed = 0 → returns { fees0: 0, fees1: 0 }", async () => {
    const zeroLiquidityPosition = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };

    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      zeroLiquidityPosition,
      poolState,
      6,
      18,
    );

    expect(result).toEqual({ fees0: 0, fees1: 0 });
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });

  it("liquidity = 0n but tokensOwed > 0 → returns fees including tokensOwed amounts", async () => {
    const zeroLiquidityWithTokensOwedPosition = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 1000n, // 1000 raw units = 0.001 with 6 decimals
      tokensOwed1: 500n,  // 500 raw units = 0.0000000000000005 with 18 decimals
    };

    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      zeroLiquidityWithTokensOwedPosition,
      poolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    // tokensOwed should be included in the result
    expect(result.fees0).toBeGreaterThan(0);
    expect(result.fees1).toBeGreaterThan(0);
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });

  it("fee growth wrap-around (feeGrowthCurrentX128 < feeGrowthLastX128) → returns non-negative fees", async () => {
    const wrapAroundPosition = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1000000n,
      // Set last to near max uint256
      feeGrowthInside0LastX128: 2n ** 256n - 1n,
      feeGrowthInside1LastX128: 2n ** 256n - 1n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };

    // Mock client that returns small current fee growth (triggers wrap-around path)
    const wrapAroundClient = {
      readContract: async () => {
        return [
          tickLowerData.liquidityGross,
          tickLowerData.liquidityNet,
          tickLowerData.feeGrowthOutside0X128,
          tickLowerData.feeGrowthOutside1X128,
        ];
      },
    };

    // Override poolState to have small feeGrowthGlobal values
    const wrapAroundPoolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 100n,  // Small value, triggers wrap-around
      feeGrowthGlobal1X128: 100n,
    };

    const result = await computeUnclaimedFees(
      wrapAroundClient as any,
      poolAddress,
      wrapAroundPosition,
      wrapAroundPoolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    // Fees should be non-negative (wrap-around should not produce negative values)
    expect(result.fees0).toBeGreaterThanOrEqual(0);
    expect(result.fees1).toBeGreaterThanOrEqual(0);
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });

  it("tick at exact range lower boundary (currentTick === tickLower) → does not throw or return NaN", async () => {
    const position = {
      tickLower: 0,
      tickUpper: 100,
      liquidity: 1000000n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 0n,
      tokensOwed1: 0n,
    };

    // Set poolState.tick to exactly tickLower
    const boundaryPoolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0, // Exactly at tickLower
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    const result = await computeUnclaimedFees(
      successClient as any,
      poolAddress,
      position,
      boundaryPoolState,
      6,
      18,
    );

    expect(result).toHaveProperty("fees0");
    expect(result).toHaveProperty("fees1");
    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    expect(isNaN(result.fees0)).toBe(false);
    expect(isNaN(result.fees1)).toBe(false);
    expect(isFinite(result.fees0)).toBe(true);
    expect(isFinite(result.fees1)).toBe(true);
  });

   it("tick at exact range upper boundary (currentTick === tickUpper) → does not throw or return NaN", async () => {
     const position = {
       tickLower: -100,
       tickUpper: 0,
       liquidity: 1000000n,
       feeGrowthInside0LastX128: 0n,
       feeGrowthInside1LastX128: 0n,
       tokensOwed0: 0n,
       tokensOwed1: 0n,
     };

     // Set poolState.tick to exactly tickUpper
     const boundaryPoolState = {
       address: poolAddress,
       sqrtPriceX96: 79228162514264337593543950336n,
       tick: 0, // Exactly at tickUpper
       feeGrowthGlobal0X128: 1000n,
       feeGrowthGlobal1X128: 2000n,
     };

     const result = await computeUnclaimedFees(
       successClient as any,
       poolAddress,
       position,
       boundaryPoolState,
       6,
       18,
     );

     expect(result).toHaveProperty("fees0");
     expect(result).toHaveProperty("fees1");
     expect(typeof result.fees0).toBe("number");
     expect(typeof result.fees1).toBe("number");
     expect(isNaN(result.fees0)).toBe(false);
     expect(isNaN(result.fees1)).toBe(false);
     expect(isFinite(result.fees0)).toBe(true);
     expect(isFinite(result.fees1)).toBe(true);
   });
});

describe("computeUnclaimedFees — output contract", () => {
  const poolAddress = "0x0000000000000000000000000000000000000001" as Address;

  // Mock client that returns zero fee growth (so only tokensOwed contributes)
  const zeroFeeGrowthClient = {
    readContract: async () => {
      return [
        0n, // liquidityGross
        0n, // liquidityNet
        0n, // feeGrowthOutside0X128
        0n, // feeGrowthOutside1X128
      ];
    },
  };

  it("return type is { fees0: number; fees1: number } (floats, not bigints)", async () => {
    const position = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 1000n,
      tokensOwed1: 2000n,
    };

    const poolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
    };

    const result = await computeUnclaimedFees(
      zeroFeeGrowthClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    expect(typeof result.fees0).toBe("number");
    expect(typeof result.fees1).toBe("number");
    expect(Number.isFinite(result.fees0)).toBe(true);
    expect(Number.isFinite(result.fees1)).toBe(true);
  });

  it("tokensOwed0/1 are included in the fee totals", async () => {
    const position = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 1000n,
      tokensOwed1: 2000n,
    };

    const poolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
    };

    const result = await computeUnclaimedFees(
      zeroFeeGrowthClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    // With token0Decimals = 6: fees0 = Number(1000n) / 10**6 = 0.001
    expect(result.fees0).toBe(0.001);
    // With token1Decimals = 18: fees1 = Number(2000n) / 10**18 = 2e-15
    expect(result.fees1).toBe(2e-15);
  });

  it("bigint round-trip in pnl.ts works: BigInt(Math.floor(fees0 * 10**decimals)) recovers the original raw amount", async () => {
    const position = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 1000n,
      tokensOwed1: 2000n,
    };

    const poolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
    };

    const result = await computeUnclaimedFees(
      zeroFeeGrowthClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    // With tokensOwed0 = 1000n, token0Decimals = 6: fees0 = 0.001
    // BigInt(Math.floor(0.001 * 10**6)) = BigInt(Math.floor(1000)) = 1000n
    const recovered0 = BigInt(Math.floor(result.fees0 * 10 ** 6));
    expect(recovered0).toBe(1000n);

    // With tokensOwed1 = 2000n, token1Decimals = 18: fees1 = 2e-15
    // BigInt(Math.floor(2e-15 * 10**18)) = BigInt(Math.floor(2000)) = 2000n
    const recovered1 = BigInt(Math.floor(result.fees1 * 10 ** 18));
    expect(recovered1).toBe(2000n);
  });

  it("object has exactly the two keys fees0 and fees1 (no extra fields)", async () => {
    const position = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 1000n,
      tokensOwed1: 2000n,
    };

    const poolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
    };

    const result = await computeUnclaimedFees(
      zeroFeeGrowthClient as any,
      poolAddress,
      position,
      poolState,
      6,
      18,
    );

    const keys = Object.keys(result).sort();
    expect(keys).toEqual(["fees0", "fees1"]);
  });

  it("when decimals are 0 (edge case), fees are integers (no division by 10^0 = 1, no Infinity)", async () => {
    const position = {
      tickLower: -100,
      tickUpper: 100,
      liquidity: 0n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0: 5n,
      tokensOwed1: 10n,
    };

    const poolState = {
      address: poolAddress,
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 0,
      feeGrowthGlobal0X128: 0n,
      feeGrowthGlobal1X128: 0n,
    };

    const result = await computeUnclaimedFees(
      zeroFeeGrowthClient as any,
      poolAddress,
      position,
      poolState,
      0, // token0Decimals = 0
      0, // token1Decimals = 0
    );

    // With token0Decimals = 0: fees0 = Number(5n) / 10**0 = 5 / 1 = 5
    expect(result.fees0).toBe(5);
    // With token1Decimals = 0: fees1 = Number(10n) / 10**0 = 10 / 1 = 10
    expect(result.fees1).toBe(10);
    expect(Number.isFinite(result.fees0)).toBe(true);
    expect(Number.isFinite(result.fees1)).toBe(true);
  });
});
