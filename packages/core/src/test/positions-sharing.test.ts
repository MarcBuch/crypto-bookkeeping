/**
 * Adversarial tests for position list sharing via rawPositions parameter:
 *  1. getAllPositions called exactly once in syncLpData
 *  2. Empty rawPositions → both caches written with empty arrays
 *  3. Single position flows through both views
 *
 * Note: Direct getPnLView tests (NotFoundError scenarios) are in pnl-direct.test.ts
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockGetAllPositionsCallCount = 0;
let mockGetAllPositionsResult: unknown = [];
let mockGetPnLView: (...args: unknown[]) => unknown = async () => [];

mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => {
    mockGetAllPositionsCallCount++;
    return mockGetAllPositionsResult;
  },
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

mock.module("../chain/pools.js", () => ({
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

mock.module("../chain/client.js", () => ({
  createClient: () => ({
    getBlockNumber: async () => 100000n,
    getLogs: async () => [],
    getBlock: async () => ({ timestamp: 1000n }),
  }),
}));

mock.module("../chain/events.js", () => ({
  findOpenEvent: async () => ({
    blockNumber: 100000n,
    amount0: 1000000000000000000n, // 1 token with 18 decimals
    amount1: 1000000000n, // 1 USDC with 6 decimals
    liquidity: 1000000000000000000n, // 1e18
  }),
  findCloseEvent: async () => null,
  getPoolPriceAtBlock: async () => ({ sqrtPriceX96: 79228162514264337593543950336n }),
}));

mock.module("../services/pnl.js", () => ({
  getPnLView: (config: unknown, tokenId?: unknown, rawPositions?: unknown) =>
    mockGetPnLView(config, tokenId, rawPositions),
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

import { resetDb } from "../db/schema.js";
import { listCachedPositionViews, listCachedPnLViews } from "../db/store.js";
import { syncLpData } from "../services/positions.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-sharing-tests";

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

const fakePosData = {
  tokenId: 111n,
  nonce: 0n,
  operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  token0: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  token1: "0x0000000000000000000000000000000000000002" as `0x${string}`,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 0n, // closed position to avoid pool state calls
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

const fakePnLView = {
  tokenId: "111",
  pair: "TEST/TEST",
  token0Symbol: "TEST",
  token1Symbol: "TEST",
  status: "closed",
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

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  process.env.LP_TRACKER_DATA_DIR = join(TMP, crypto.randomUUID());
  resetDb();
  // Reset mocks to safe defaults
  mockGetAllPositionsCallCount = 0;
  mockGetAllPositionsResult = [];
  mockGetPnLView = async () => [];
});

afterEach(() => {
  delete process.env.LP_TRACKER_DATA_DIR;
  resetDb();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: getAllPositions called exactly once in syncLpData
// ---------------------------------------------------------------------------

describe("syncLpData — position sharing", () => {
  it("calls getAllPositions exactly once when syncing", async () => {
    mockGetAllPositionsCallCount = 0;
    mockGetAllPositionsResult = [];

    await syncLpData(fakeConfig);

    expect(mockGetAllPositionsCallCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 2: Empty rawPositions → both caches written with empty arrays
  // -----------------------------------------------------------------------

  it("writes empty position cache when getAllPositions returns []", async () => {
    mockGetAllPositionsResult = [];

    await syncLpData(fakeConfig);

    const positions = listCachedPositionViews();
    expect(positions).toEqual([]);
  });

  it("writes empty pnl cache when getAllPositions returns []", async () => {
    mockGetAllPositionsResult = [];

    await syncLpData(fakeConfig);

    const pnls = listCachedPnLViews();
    expect(pnls).toEqual([]);
  });

  it("returns positionCount 0 for empty positions", async () => {
    mockGetAllPositionsResult = [];

    const result = await syncLpData(fakeConfig);

    expect(result.positionCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 3: Single position flows through both views
  // -----------------------------------------------------------------------

  it("writes single position to cache when getAllPositions returns one", async () => {
    mockGetAllPositionsResult = [fakePosData];

    await syncLpData(fakeConfig);

    const positions = listCachedPositionViews();
    expect(positions.length).toBe(1);
  });

  it("writes single pnl view to cache when getAllPositions returns one", async () => {
    mockGetAllPositionsResult = [fakePosData];
    mockGetPnLView = async () => [fakePnLView];

    await syncLpData(fakeConfig);

    const pnls = listCachedPnLViews();
    expect(pnls.length).toBe(1);
  });

  it("returns correct positionCount when single position exists", async () => {
    mockGetAllPositionsResult = [fakePosData];
    mockGetPnLView = async () => [fakePnLView];

    const result = await syncLpData(fakeConfig);

    expect(result.positionCount).toBe(1);
  });
});
