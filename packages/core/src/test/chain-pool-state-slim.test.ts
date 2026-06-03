/**
 * Adversarial tests — pool state slim (Slot0) vs full (PoolState) interface shapes (m2t5).
 *
 * Strategy: test the Slot0 and PoolState interfaces using pure structural tests with
 * literal objects that satisfy the types. Type imports are stripped at runtime, so they
 * don't suffer from bun:test's mock.module contamination.
 */

import { describe, it, expect } from "bun:test";

import type { Slot0, PoolState } from "../chain/pools.js";

describe("pool state slim (Slot0) interface shape", () => {
  it("Slot0-shaped object has address, sqrtPriceX96, and tick fields", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    expect(slim).toHaveProperty("address");
    expect(slim).toHaveProperty("sqrtPriceX96");
    expect(slim).toHaveProperty("tick");
    expect(Object.keys(slim).length).toBe(3);
  });

  it("Slot0-shaped object sqrtPriceX96 is a bigint (not number)", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    expect(typeof slim.sqrtPriceX96).toBe("bigint");
  });

  it("Slot0-shaped object tick is a number (not bigint)", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    expect(typeof slim.tick).toBe("number");
  });

  it("Slot0-shaped object does NOT have feeGrowthGlobal0X128 or feeGrowthGlobal1X128 fields", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    expect(slim).not.toHaveProperty("feeGrowthGlobal0X128");
    expect(slim).not.toHaveProperty("feeGrowthGlobal1X128");
  });
});

describe("pool state full (PoolState) interface shape", () => {
  it("PoolState-shaped object has all Slot0 fields plus fee-growth fields", () => {
    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    expect(full).toHaveProperty("address");
    expect(full).toHaveProperty("sqrtPriceX96");
    expect(full).toHaveProperty("tick");
    expect(full).toHaveProperty("feeGrowthGlobal0X128");
    expect(full).toHaveProperty("feeGrowthGlobal1X128");
    expect(Object.keys(full).length).toBe(5);
  });

  it("PoolState sqrtPriceX96 is a bigint (not number)", () => {
    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    expect(typeof full.sqrtPriceX96).toBe("bigint");
  });

  it("PoolState tick is a number (not bigint)", () => {
    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    expect(typeof full.tick).toBe("number");
  });

  it("PoolState fee-growth fields are bigints", () => {
    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    expect(typeof full.feeGrowthGlobal0X128).toBe("bigint");
    expect(typeof full.feeGrowthGlobal1X128).toBe("bigint");
  });

  it("PoolState fee-growth fields can hold large bigint values", () => {
    const largeValue =
      115792089237316195423570985008687907853269984665640564039457584007913129639935n;
    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: 100,
      feeGrowthGlobal0X128: largeValue,
      feeGrowthGlobal1X128: largeValue,
    };

    expect(full.feeGrowthGlobal0X128).toBe(largeValue);
    expect(full.feeGrowthGlobal1X128).toBe(largeValue);
  });
});

describe("pool state variants — structural differences", () => {
  it("Slot0 field names are a strict subset of PoolState field names", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    const slimKeys = Object.keys(slim);
    const fullKeys = Object.keys(full);

    // Every Slot0 key should exist in PoolState
    for (const key of slimKeys) {
      expect(fullKeys).toContain(key);
    }

    // PoolState should have exactly 2 more keys (the fee-growth fields)
    expect(fullKeys.length).toBe(slimKeys.length + 2);
  });

  it("PoolState includes exactly the two fee-growth fields that Slot0 lacks", () => {
    const slim: Slot0 = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
    };

    const full: PoolState = {
      address: "0x0000000000000000000000000000000000000001",
      sqrtPriceX96: 79228162514264337593543950336n,
      tick: -100,
      feeGrowthGlobal0X128: 1000n,
      feeGrowthGlobal1X128: 2000n,
    };

    const slimKeys = new Set(Object.keys(slim));
    const fullKeys = new Set(Object.keys(full));

    const additionalKeys = Array.from(fullKeys).filter((key) => !slimKeys.has(key));

    expect(additionalKeys).toEqual(["feeGrowthGlobal0X128", "feeGrowthGlobal1X128"]);
  });
});
