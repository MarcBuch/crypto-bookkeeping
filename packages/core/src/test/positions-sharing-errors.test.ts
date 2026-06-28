/**
 * Adversarial tests for syncLpData position list sharing error propagation:
 *  Scenario 1: getPositionsView throws AFTER getAllPositions succeeds → cache unchanged
 *  Scenario 2: getPnLView throws AFTER getAllPositions AND getPositionsView succeed → cache unchanged
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockGetAllPositions: () => unknown = async () => [];
let mockGetTokenInfo: (...args: unknown[]) => Promise<unknown> = async () => ({
  symbol: "TEST",
  decimals: 18,
});
let mockGetPoolAddress: (...args: unknown[]) => Promise<unknown> = async () =>
  "0x0000000000000000000000000000000000000099";
let mockGetSlot0: (...args: unknown[]) => Promise<unknown> = async () => ({
  address: "0x0000000000000000000000000000000000000099",
  sqrtPriceX96: 79228162514264337593543950336n,
  tick: 0,
});
let mockGetPoolState: (...args: unknown[]) => Promise<unknown> = async () => ({
  sqrtPriceX96: 79228162514264337593543950336n,
  tick: 0,
  feeGrowthGlobal0X128: 0n,
  feeGrowthGlobal1X128: 0n,
});
let mockGetPnLView: (...args: unknown[]) => Promise<unknown> = async () => [];

await mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

await mock.module("../chain/pools.js", () => ({
  getTokenInfo: (arg1: unknown, arg2: unknown) => mockGetTokenInfo(arg1, arg2),
  getPoolAddress: (arg1: unknown, arg2: unknown, arg3: unknown, arg4: unknown, arg5: unknown) =>
    mockGetPoolAddress(arg1, arg2, arg3, arg4, arg5),
  getSlot0: (arg1: unknown, arg2: unknown) => mockGetSlot0(arg1, arg2),
  getPoolState: (arg1: unknown, arg2: unknown) => mockGetPoolState(arg1, arg2),
  getTickData: async () => ({
    feeGrowthOutside0X128: 0n,
    feeGrowthOutside1X128: 0n,
  }),
}));

await mock.module("../services/pnl.js", () => ({
  getPnLView: (arg1: unknown, arg2?: unknown, arg3?: unknown) => mockGetPnLView(arg1, arg2, arg3),
}));

await mock.module("../services/hedge.js", () => ({
  syncHyperliquidHedgeTrades: async () => 0,
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
  replaceCachedPositionViews,
  replaceCachedPnLViews,
} from "../db/store.js";
import { syncLpData } from "../services/positions.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

useTestDb();

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

// Fake raw position data returned by getAllPositions
const fakeRawPosition = {
  tokenId: 12345n,
  nonce: 0n,
  operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  token0: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
  token1: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 1000000n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

// Cached position view sentinel data
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

// Cached PnL view sentinel data
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

function hasBigIntTokenId(value: unknown): value is { tokenId: bigint } {
  return (
    typeof value === "object" &&
    value !== null &&
    "tokenId" in value &&
    typeof value.tokenId === "bigint"
  );
}

function expectStringTokenId(value: unknown, tokenId: string): void {
  expect(hasStringTokenId(value)).toBe(true);
  if (!hasStringTokenId(value)) {
    return;
  }

  expect(value.tokenId).toBe(tokenId);
}

function expectBigIntTokenId(value: unknown, tokenId: bigint): void {
  expect(hasBigIntTokenId(value)).toBe(true);
  if (!hasBigIntTokenId(value)) {
    return;
  }

  expect(value.tokenId).toBe(tokenId);
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset mocks to safe defaults
  mockGetAllPositions = async () => [];
  mockGetTokenInfo = async () => ({
    symbol: "TEST",
    decimals: 18,
  });
  mockGetPoolAddress = async () => "0x0000000000000000000000000000000000000099";
  mockGetSlot0 = async () => ({
    address: "0x0000000000000000000000000000000000000099",
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
  });
  mockGetPoolState = async () => ({
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  });
  mockGetPnLView = async () => [];
});

afterEach(() => {
  // (cleanup handled by useTestDb)
});

// ---------------------------------------------------------------------------
// Scenario 1: getPositionsView throws AFTER getAllPositions succeeds
// ---------------------------------------------------------------------------

describe("syncLpData — getPositionsView throws (position list sharing)", () => {
  it("rejects when getPoolAddress throws during getPositionsView", async () => {
    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPoolAddress = async () => {
      throw new Error("pool lookup failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "pool lookup failed");
    }
  });

  it("leaves position cache unchanged when getPoolAddress throws", async () => {
    // Pre-populate both caches with sentinel data
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPoolAddress = async () => {
      throw new Error("pool lookup failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    // Position cache must be unchanged
    const positions = listCachedPositionViews();
    expect(positions).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
  });

  it("leaves pnl cache unchanged when getPoolAddress throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPoolAddress = async () => {
      throw new Error("pool lookup failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    // PnL cache must be unchanged
    const pnl = listCachedPnLViews();
    expect(pnl).toHaveLength(1);
    expectStringTokenId(pnl[0], "12345");
  });

  it("rejects when getSlot0 throws during getPositionsView", async () => {
    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetSlot0 = async () => {
      throw new Error("slot0 fetch failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "slot0 fetch failed");
    }
  });

  it("leaves both caches unchanged when getSlot0 throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetSlot0 = async () => {
      throw new Error("slot0 fetch failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    const positions = listCachedPositionViews();
    const pnl = listCachedPnLViews();
    expect(positions).toHaveLength(1);
    expect(pnl).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
    expectStringTokenId(pnl[0], "12345");
  });

  it("rejects when getTokenInfo throws during getPositionsView", async () => {
    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetTokenInfo = async () => {
      throw new Error("token info fetch failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "token info fetch failed");
    }
  });

  it("leaves both caches unchanged when getTokenInfo throws", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetTokenInfo = async () => {
      throw new Error("token info fetch failed");
    };
    mockGetPnLView = async () => [];

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    const positions = listCachedPositionViews();
    const pnl = listCachedPnLViews();
    expect(positions).toHaveLength(1);
    expect(pnl).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
    expectStringTokenId(pnl[0], "12345");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: getPnLView throws AFTER both getAllPositions and getPositionsView succeed
// ---------------------------------------------------------------------------

describe("syncLpData — getPnLView throws with shared position list", () => {
  it("rejects when getPnLView throws with empty positions list", async () => {
    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => {
      throw new Error("pnl view exploded");
    };

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "pnl view exploded");
    }
  });

  it("leaves both caches unchanged when getPnLView throws (empty list case)", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [];
    mockGetPnLView = async () => {
      throw new Error("pnl view exploded");
    };

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    const positions = listCachedPositionViews();
    const pnl = listCachedPnLViews();
    expect(positions).toHaveLength(1);
    expect(pnl).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
    expectStringTokenId(pnl[0], "12345");
  });

  it("rejects when getPnLView throws with non-empty positions list", async () => {
    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPnLView = async () => {
      throw new Error("pnl view exploded");
    };

    try {
      await syncLpData(fakeConfig);
      throw new Error("Expected syncLpData to reject");
    } catch (error) {
      expectErrorMessage(error, "pnl view exploded");
    }
  });

  it("leaves both caches unchanged when getPnLView throws (with positions)", async () => {
    replaceCachedPositionViews([fakePositionView], "2026-06-01T00:00:00.000Z");
    replaceCachedPnLViews([fakePnLView], "2026-06-01T00:00:00.000Z");

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPnLView = async () => {
      throw new Error("pnl view exploded");
    };

    try {
      await syncLpData(fakeConfig);
    } catch {
      // expected to throw
    }

    const positions = listCachedPositionViews();
    const pnl = listCachedPnLViews();
    expect(positions).toHaveLength(1);
    expect(pnl).toHaveLength(1);
    expectStringTokenId(positions[0], "12345");
    expectStringTokenId(pnl[0], "12345");
  });

  it("verifies that getPnLView receives the shared rawPositions from getAllPositions", async () => {
    const positionsPassedToPnL: unknown[] = [];

    mockGetAllPositions = async () => [fakeRawPosition];
    mockGetPnLView = async (_config: unknown, _tokenId: unknown, rawPositions: unknown) => {
      if (Array.isArray(rawPositions)) {
        positionsPassedToPnL.push(...rawPositions);
      }
      return [];
    };

    await syncLpData(fakeConfig);

    // Verify getPnLView received the same position list
    expect(positionsPassedToPnL).toHaveLength(1);
    expectBigIntTokenId(positionsPassedToPnL[0], fakeRawPosition.tokenId);
  });
});
