/**
 * Adversarial tests for syncSinglePosition:
 *  Group 1: Validation tests
 *    1. Empty tokenId throws: syncSinglePosition(config, "") rejects with /Invalid tokenId/
 *    2. Non-numeric tokenId throws: syncSinglePosition(config, "abc") rejects with /Invalid tokenId/
 *    3. Decimal tokenId throws: syncSinglePosition(config, "1.5") rejects with /Invalid tokenId/
 *    4. Negative tokenId throws: syncSinglePosition(config, "-1") rejects with /Invalid tokenId/
 *
 *  Group 2: RPC error propagation
 *    5. getPositionData throws → error propagates, no cache write
 *    6. getPnLView throws → error propagates, no cache write
 *
 *  Note: Testing "getPositionsView returns empty" is not possible with current mock architecture
 *  since getPositionsView is defined in the same module and can only throw or return non-empty
 *  (given non-empty input). The check for empty result at line 170-171 ensures the function
 *  throws if somehow the view building fails, which is tested implicitly.
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockGetPositionData: (...args: unknown[]) => unknown = async () => ({});
let mockGetPnLView: (...args: unknown[]) => unknown = async () => [];

await mock.module("../chain/positions.js", () => ({
  getAllPositions: async () => [],
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: (...args: unknown[]) => mockGetPositionData(...args),
}));

await mock.module("../chain/pools.js", () => ({
  getTokenInfo: async () => ({ symbol: "TEST", decimals: 18 }),
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099",
  getSlot0: async () => ({
    address: "0x0000000000000000000000000000000000000099",
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
  }),
  getPoolState: async () => ({
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }),
  getTickData: async () => ({
    feeGrowthOutside0X128: 0n,
    feeGrowthOutside1X128: 0n,
  }),
}));

await mock.module("../chain/client.js", () => ({
  createClient: () => ({}),
}));

await mock.module("../chain/events.js", () => ({
  findOpenEvent: async () => ({
    blockNumber: 100000n,
    amount0: 1000000000000000000n,
    amount1: 1000000000n,
    liquidity: 1000000000000000000n,
  }),
  findCloseEvent: async () => null,
  getPoolPriceAtBlock: async () => ({ sqrtPriceX96: 79228162514264337593543950336n }),
}));

await mock.module("../services/pnl.js", () => ({
  getPnLView: (...args: unknown[]) => mockGetPnLView(...args),
  calculateUsdFeeIncome: () => ({
    feesCollected0Usd: null,
    feesCollected1Usd: null,
    feesValueUsd: null,
    usdPriceSource: null,
  }),
}));

// ---------------------------------------------------------------------------
// Now import the module under test + DB helpers
// ---------------------------------------------------------------------------

import {
  listCachedPositionViews,
  listCachedPnLViews,
  replaceCachedPnLViews,
  upsertPositionViewCache,
} from "../db/store.js";
import { syncSinglePosition } from "../services/positions.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeConfig = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
};

const fakeRawPosition = {
  tokenId: 12345n,
  liquidity: 1000000000000000000n,
  tickLower: -100,
  tickUpper: 100,
  token0: "0x0000000000000000000000000000000000000aaa",
  token1: "0x0000000000000000000000000000000000000bbb",
  fee: 3000,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

const fakePnLView = {
  tokenId: "12345",
  pair: "WHYPE/USDC",
  token0Symbol: "WHYPE",
  token1Symbol: "USDC",
  openedAt: "2026-05-01T00:00:00.000Z",
  status: "active",
  entryPrice: 1.0,
  exitPrice: 1.5,
  priceChangePercent: 0.5,
  entryAmount0: 10.0,
  entryAmount1: 10.0,
  exitAmount0: 8.0,
  exitAmount1: 11.0,
  feesCollected0: 0.1,
  feesCollected1: 0.05,
  feesCollected0Usd: null,
  feesCollected1Usd: null,
  feesValueUsd: null,
  token0UsdPrice: null,
  token1UsdPrice: null,
  usdPriceSource: null,
  feesValueInToken1: 0.15,
  entryValueInToken1: 20.0,
  exitValueInToken1: 23.0,
  holdValueInToken1: 22.0,
  absolutePnlInToken1: 3.0,
  absolutePnlPercent: 0.15,
  divergenceLossPercent: -0.01,
  opportunityCostInToken1: 0.2,
  netVsHodlPercent: 0.05,
  priceLower: 0.8,
  priceUpper: 2.0,
};

const cachedPnLViewWithUsd = {
  ...fakePnLView,
  tokenId: "42",
  token0UsdPrice: 123.45,
  token1UsdPrice: 1.0,
  feesCollected0Usd: 12.34,
  feesCollected1Usd: 5.67,
  feesValueUsd: 18.01,
  usdPriceSource: "coingecko" as const,
  pendingFeesValueUsd: 9.87,
};

const freshPnLViewWithUsd = {
  ...fakePnLView,
  tokenId: "42",
  token0UsdPrice: 222.22,
  token1UsdPrice: 1.11,
  feesCollected0Usd: 22.22,
  feesCollected1Usd: 6.78,
  feesValueUsd: 29.0,
  usdPriceSource: "coingecko" as const,
  pendingFeesValueUsd: 10.5,
};

function expectErrorMessage(error: unknown, matcher: string | RegExp): void {
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    return;
  }

  if (typeof matcher === "string") {
    expect(error.message).toContain(matcher);
    return;
  }

  expect(error.message).toMatch(matcher);
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  // Reset mocks to safe defaults
  mockGetPositionData = async () => fakeRawPosition;
  mockGetPnLView = async () => [fakePnLView];
});

afterEach(() => {
  // afterEach is handled by useTestDb()
});

// ---------------------------------------------------------------------------
// Group 1: Validation tests
// ---------------------------------------------------------------------------

describe("syncSinglePosition — validation", () => {
  it("empty tokenId throws Invalid tokenId error", async () => {
    try {
      await syncSinglePosition(fakeConfig, "");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, /Invalid tokenId/);
    }
  });

  it("non-numeric tokenId throws Invalid tokenId error", async () => {
    try {
      await syncSinglePosition(fakeConfig, "abc");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, /Invalid tokenId/);
    }
  });

  it("decimal tokenId throws Invalid tokenId error", async () => {
    try {
      await syncSinglePosition(fakeConfig, "1.5");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, /Invalid tokenId/);
    }
  });

  it("negative tokenId throws Invalid tokenId error", async () => {
    try {
      await syncSinglePosition(fakeConfig, "-1");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, /Invalid tokenId/);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2: RPC error propagation
// ---------------------------------------------------------------------------

describe("syncSinglePosition — RPC error propagation", () => {
  it("getPositionData throws → error propagates, no cache write", async () => {
    mockGetPositionData = async () => {
      throw new Error("RPC timeout");
    };

    try {
      await syncSinglePosition(fakeConfig, "12345");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, "RPC timeout");
    }

    // Verify cache is empty (no partial write)
    const positions = listCachedPositionViews();
    expect(positions).toHaveLength(0);

    const pnlViews = listCachedPnLViews();
    expect(pnlViews).toHaveLength(0);
  });

  it("getPnLView throws → error propagates, no cache write", async () => {
    mockGetPositionData = async () => fakeRawPosition;
    mockGetPnLView = async () => {
      throw new Error("PnL calculation failed");
    };

    // Should throw because getPnLView throws before cache writes
    try {
      await syncSinglePosition(fakeConfig, "12345");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, "PnL calculation failed");
    }

    // Cache should be empty (no partial write)
    const positions = listCachedPositionViews();
    expect(positions).toHaveLength(0);

    const pnlViews = listCachedPnLViews();
    expect(pnlViews).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 3: Partial failure and idempotency
// ---------------------------------------------------------------------------

describe("syncSinglePosition — partial failure and idempotency", () => {
  it("preserves cached USD fields when live pricing is null", async () => {
    replaceCachedPnLViews([cachedPnLViewWithUsd], "2026-06-01T00:00:00.000Z");
    mockGetPnLView = async () => [fakePnLView];

    await syncSinglePosition(fakeConfig, "42");

    const pnlViews = listCachedPnLViews();
    expect(pnlViews).toHaveLength(1);
    expect(pnlViews[0].token0UsdPrice).toBe(123.45);
    expect(pnlViews[0].token1UsdPrice).toBe(1.0);
    expect(pnlViews[0].feesValueUsd).toBe(18.01);
    expect(pnlViews[0].usdPriceSource).toBe("coingecko");
  });

  it("replaces cached USD fields when fresh pricing is available", async () => {
    replaceCachedPnLViews([cachedPnLViewWithUsd], "2026-06-01T00:00:00.000Z");
    mockGetPnLView = async () => [freshPnLViewWithUsd];

    await syncSinglePosition(fakeConfig, "42");

    const pnlViews = listCachedPnLViews();
    expect(pnlViews).toHaveLength(1);
    expect(pnlViews[0].token0UsdPrice).toBe(222.22);
    expect(pnlViews[0].token1UsdPrice).toBe(1.11);
    expect(pnlViews[0].feesValueUsd).toBe(29.0);
    expect(pnlViews[0].pendingFeesValueUsd).toBe(10.5);
  });

  it("existing cache row is preserved when getPositionData throws", async () => {
    // Pre-seed the DB with an existing cache row
    const originalData = { version: "original", tokenId: "42" };
    upsertPositionViewCache("42", originalData, "2024-01-01T00:00:00Z");

    // Verify it's in the cache
    let cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(1);
    expect(cachedPositions[0].version).toBe("original");

    // Configure mock to throw
    mockGetPositionData = async () => {
      throw new Error("RPC error during fetch");
    };

    // Call syncSinglePosition — should throw
    try {
      await syncSinglePosition(fakeConfig, "42");
      throw new Error("Expected syncSinglePosition to reject");
    } catch (error) {
      expectErrorMessage(error, "RPC error during fetch");
    }

    // Verify the original cache row is still there (was NOT overwritten)
    cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(1);
    expect(cachedPositions[0].version).toBe("original");
  });

  it("successful sync on second call overwrites previous data (idempotency)", async () => {
    // Create two different position data objects (same tokenId, different data)
    const positionDataV1 = {
      tokenId: 42n,
      liquidity: 1000000000000000000n,
      tickLower: -100,
      tickUpper: 100,
      token0: "0x0000000000000000000000000000000000000aaa",
      token1: "0x0000000000000000000000000000000000000bbb",
      fee: 3000,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    };

    const positionDataV2 = {
      ...positionDataV1,
      liquidity: 2000000000000000000n, // Different liquidity
    };

    // First call: sync with position data V1
    mockGetPositionData = async () => positionDataV1;
    mockGetPnLView = async () => [fakePnLView];

    const result1 = await syncSinglePosition(fakeConfig, "42");
    expect(result1.tokenId).toBe("42");

    // Verify cache has 1 row with V1 data
    let cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(1);
    expect(cachedPositions[0].liquidity).toBe("1000000000000000000");

    // Second call: sync with position data V2 (same tokenId, different data)
    mockGetPositionData = async () => positionDataV2;

    const result2 = await syncSinglePosition(fakeConfig, "42");
    expect(result2.tokenId).toBe("42");

    // Verify cache still has only 1 row (not 2), with V2 data
    cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(1);
    expect(cachedPositions[0].liquidity).toBe("2000000000000000000");
  });

  it("two different tokenIds can be synced independently without interfering", async () => {
    // Create position data for tokenId "10"
    const positionData10 = {
      tokenId: 10n,
      liquidity: 1000000000000000000n,
      tickLower: -200,
      tickUpper: 200,
      token0: "0x0000000000000000000000000000000000000aaa",
      token1: "0x0000000000000000000000000000000000000bbb",
      fee: 3000,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    };

    // Create position data for tokenId "20"
    const positionData20 = {
      tokenId: 20n,
      liquidity: 2000000000000000000n,
      tickLower: -100,
      tickUpper: 100,
      token0: "0x0000000000000000000000000000000000000ccc",
      token1: "0x0000000000000000000000000000000000000ddd",
      fee: 500,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
    };

    // Sync tokenId "10"
    mockGetPositionData = async () => positionData10;
    mockGetPnLView = async () => [fakePnLView];

    await syncSinglePosition(fakeConfig, "10");

    // Verify 1 row in cache
    let cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(1);
    expect(cachedPositions[0].tokenId).toBe("10");

    // Sync tokenId "20"
    mockGetPositionData = async () => positionData20;

    await syncSinglePosition(fakeConfig, "20");

    // Verify now 2 rows in cache
    cachedPositions = listCachedPositionViews();
    expect(cachedPositions).toHaveLength(2);

    // Verify each row has the correct data
    const cached10 = cachedPositions.find((p) => p.tokenId === "10");
    const cached20 = cachedPositions.find((p) => p.tokenId === "20");

    expect(cached10).toBeDefined();
    expect(cached10?.liquidity).toBe("1000000000000000000");
    expect(cached10?.fee).toBe(3000);

    expect(cached20).toBeDefined();
    expect(cached20?.liquidity).toBe("2000000000000000000");
    expect(cached20?.fee).toBe(500);
  });
});
