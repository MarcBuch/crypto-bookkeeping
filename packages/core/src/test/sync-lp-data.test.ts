/**
 * Adversarial tests for syncLpData:
 *  1. getPnLView throws → cache unchanged
 *  2. getPositionsView throws (getAllPositions throws) → cache unchanged
 *  3. Empty wallet (zero positions) → caches cleared, sync state updated
 *  4. Returns correct SyncLpDataSummary
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockGetAllPositions: () => unknown = async () => [];
let mockGetPnLView: (config: unknown) => unknown = async () => [];

await mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

await mock.module("../services/pnl.js", () => ({
  getPnLView: (config: unknown, _tokenId?: unknown, _rawPositions?: unknown) =>
    mockGetPnLView(config),
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

// ---------------------------------------------------------------------------
// Now import the module under test + DB helpers
// ---------------------------------------------------------------------------

import {
  listCachedPositionViews,
  listCachedPnLViews,
  getLpSyncState,
  replaceCachedPositionViews,
  replaceCachedPnLViews,
} from "../db/store.js";
import { syncLpData } from "../services/positions.js";
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

const fakePositionView = {
  tokenId: "12345",
  token0: { address: "0xabc", symbol: "WHYPE", decimals: 18 },
  token1: { address: "0xdef", symbol: "USDC", decimals: 6 },
  fee: 3000,
  feePercent: 0.3,
  tickLower: -100,
  tickUpper: 100,
  priceLower: 1.0,
  priceUpper: 2.0,
  currentPrice: 1.5,
  liquidity: "1000000000",
  status: "active",
  inRange: true,
  currentAmount0: 5.0,
  currentAmount1: 7.5,
};

const fakePnLView = {
  tokenId: "12345",
  pair: "WHYPE/USDC",
  token0Symbol: "WHYPE",
  token1Symbol: "USDC",
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

function hasStringTokenId(value: unknown): value is { tokenId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tokenId" in value &&
    typeof value.tokenId === "string"
  );
}

function expectStringTokenId(value: unknown, tokenId: string): void {
  expect(hasStringTokenId(value)).toBe(true);
  if (!hasStringTokenId(value)) {
    return;
  }

  expect(value.tokenId).toBe(tokenId);
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  // Reset mocks to safe defaults
  mockGetAllPositions = async () => [];
  mockGetPnLView = async () => [];
});

afterEach(() => {
  // afterEach is handled by useTestDb()
});

// ---------------------------------------------------------------------------
// Test 1: getPnLView throws → cache unchanged
// ---------------------------------------------------------------------------

describe("syncLpData — getPnLView throws", () => {
  it("rejects when getPnLView throws", async () => {
    mockGetPnLView = async () => {
      throw new Error("pnl fetch failed");
    };
    mockGetAllPositions = async () => [];

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "pnl fetch failed");
    }
  });

  it("leaves position cache unchanged when getPnLView throws", async () => {
    // Pre-populate caches
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetPnLView = async () => {
      throw new Error("pnl network error");
    };
    mockGetAllPositions = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected
    }

    // Cache must be unchanged
    const positions = listCachedPositionViews();
    expect(positions).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
  });

  it("leaves pnl cache unchanged when getPnLView throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetPnLView = async () => {
      throw new Error("pnl network error");
    };

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected
    }

    const pnl = listCachedPnLViews();
    expect(pnl).toHaveLength(1);
    expectStringTokenId(pnl[0], "12345");
  });
});

// ---------------------------------------------------------------------------
// Test 2: getPositionsView throws (getAllPositions throws) → cache unchanged
// ---------------------------------------------------------------------------

describe("syncLpData — getPositionsView throws", () => {
  it("rejects when getAllPositions throws", async () => {
    mockGetAllPositions = async () => {
      throw new Error("chain RPC failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "chain RPC failed");
    }
  });

  it("leaves position cache unchanged when getAllPositions throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => {
      throw new Error("chain RPC failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected
    }

    const positions = listCachedPositionViews();
    expect(positions).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
  });

  it("leaves pnl cache unchanged when getAllPositions throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => {
      throw new Error("chain RPC failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected
    }

    const pnl = listCachedPnLViews();
    expect(pnl).toHaveLength(1);
    expectStringTokenId(pnl[0], "12345");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Empty wallet (zero positions) → caches cleared, sync state updated
// ---------------------------------------------------------------------------

describe("syncLpData — empty wallet", () => {
  it("resolves successfully with zero positions", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const result = await syncLpData(fakeConfig);
    expect(result).toBeDefined();
  });

  it("sets positionCount to 0 for empty wallet", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const result = await syncLpData(fakeConfig);
    expect(result.positionCount).toBe(0);
  });

  it("clears position cache for empty wallet", async () => {
    // Pre-populate
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    expect(listCachedPositionViews()).toHaveLength(1);

    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    await syncLpData(fakeConfig);

    expect(listCachedPositionViews()).toEqual([]);
  });

  it("clears pnl cache for empty wallet", async () => {
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");
    expect(listCachedPnLViews()).toHaveLength(1);

    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    await syncLpData(fakeConfig);

    expect(listCachedPnLViews()).toEqual([]);
  });

  it("updates sync state for wallet after successful empty sync", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const before = getLpSyncState(fakeConfig.wallet);
    expect(before).toBeNull();

    await syncLpData(fakeConfig);

    const state = getLpSyncState(fakeConfig.wallet);
    expect(state).not.toBeNull();
    expect(state!.wallet).toBe(fakeConfig.wallet);
    expect(typeof state!.last_synced_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Returns correct SyncLpDataSummary
// ---------------------------------------------------------------------------

describe("syncLpData — summary result", () => {
  it("returns wallet from config", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const result = await syncLpData(fakeConfig);
    expect(result.wallet).toBe(fakeConfig.wallet);
  });

  it("returns syncedAt as a valid ISO string", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const result = await syncLpData(fakeConfig);
    expect(typeof result.syncedAt).toBe("string");
    expect(() => new Date(result.syncedAt)).not.toThrow();
    expect(new Date(result.syncedAt).toISOString()).toBe(result.syncedAt);
  });

  it("syncedAt matches the last_synced_at stored in sync state", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => [];

    const result = await syncLpData(fakeConfig);
    const state = getLpSyncState(fakeConfig.wallet);

    expect(state!.last_synced_at).toBe(result.syncedAt);
  });
});
