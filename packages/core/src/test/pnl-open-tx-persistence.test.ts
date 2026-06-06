/**
 * Adversarial tests: open_tx persistence and fast-path promotion in getPnLView
 *
 * 1. slow-path persists open_tx
 * 2. config fast-path persists open_tx
 * 3. DB fast-path skips findOpenEvent
 * 4. DB fast-path does not overwrite existing open_tx with null
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockFindOpenEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findOpenEventCallCount = 0;

let mockFindCloseEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findCloseEventCallCount = 0;

mock.module("../chain/events.js", () => ({
  findOpenEvent: (...args: unknown[]) => {
    findOpenEventCallCount++;
    return mockFindOpenEvent(...args);
  },
  findCloseEvent: (...args: unknown[]) => {
    findCloseEventCallCount++;
    return mockFindCloseEvent(...args);
  },
  getPoolPriceAtBlock: async () => null,
}));

mock.module("../chain/client.js", () => ({
  createClient: () => ({
    getBlockNumber: async () => 1000n,
  }),
}));

mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

mock.module("../chain/pools.js", () => ({
  getTokenInfo: async () => ({ symbol: "TOK", decimals: 18 }),
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099" as const,
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

let mockGetAllPositions: () => unknown = async () => [];

mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

mock.module("../services/pricing.js", () => ({
  getUsdPrices: async () => ({}),
}));

mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => 79228162514264337593543950336n,
  getTokenAmounts: () => ({ amount0: 500n, amount1: 500n }),
  calculateFeeGrowthInside: () => ({
    feeGrowthInside0X128: 0n,
    feeGrowthInside1X128: 0n,
  }),
  calculateUnclaimedFees: () => ({ fees0: 0, fees1: 0 }),
  calculateFullPnL: () => ({
    entryPrice: 1.0,
    exitPrice: 1.0,
    entryAmount0: 1.0,
    entryAmount1: 1.0,
    exitAmount0: 1.0,
    exitAmount1: 1.0,
    feesCollected0: 0,
    feesCollected1: 0,
    feesValue: 0,
    entryValue: 2.0,
    exitValue: 2.0,
    holdValue: 2.0,
    absolutePnl: 0,
    absolutePnlPercent: 0,
    divergenceLoss: 0,
    opportunityCost: 0,
    netVsHodl: 0,
    priceLower: 0.5,
    priceUpper: 2.0,
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import { getPosition, upsertPosition } from "../db/store.js";
import { getPnLView } from "../services/pnl.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN_ID = "42";

const fakePos = {
  tokenId: 42n,
  nonce: 0n,
  operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  token0: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`,
  token1: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as `0x${string}`,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 1000000n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

const fakeOpenEvent = {
  tokenId: 42n,
  blockNumber: 100n,
  transactionHash: "0xSLOW",
  amount0: 1000n,
  amount1: 2000n,
  liquidity: 1000000n,
};

const baseConfig = {
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

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  findOpenEventCallCount = 0;
  mockFindOpenEvent = async () => ({ status: "not_found" });
  mockFindCloseEvent = async () => ({ status: "not_found" });
  mockGetAllPositions = async () => [fakePos];
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("open_tx persistence and fast-path", () => {
  it("slow-path persists open_tx after findOpenEvent returns a result", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xSLOW" },
    });

    await getPnLView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.open_tx).toBe("0xSLOW");
  });

  it("config fast-path persists open_tx when posConfig.openTx is set", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xCONFIG" },
    });

    const config = {
      ...baseConfig,
      positions: {
        [TOKEN_ID]: { openTx: "0xCONFIG" },
      },
    };

    await getPnLView(config);

    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.open_tx).toBe("0xCONFIG");
  });

  it("DB fast-path skips findOpenEvent when open_tx is already stored", async () => {
    // Pre-seed the DB with open_tx and entry data
    upsertPosition({
      token_id: TOKEN_ID,
      token0: fakePos.token0,
      token1: fakePos.token1,
      token0_symbol: "TOK",
      token1_symbol: "TOK",
      token0_decimals: 18,
      token1_decimals: 18,
      fee: fakePos.fee,
      tick_lower: fakePos.tickLower,
      tick_upper: fakePos.tickUpper,
      entry_sqrt_price_x96: "79228162514264337593543950336",
      entry_block: 100,
      entry_amount0: "1000",
      entry_amount1: "2000",
      entry_liquidity: "1000000",
      open_tx: "0xSTORED",
    });

    // Ensure findOpenEvent is not called
    findOpenEventCallCount = 0;

    await getPnLView(baseConfig);

    expect(findOpenEventCallCount).toBe(0);
  });

  it("DB fast-path does not overwrite existing open_tx with null on second sync", async () => {
    // First sync — slow path discovers and stores open_tx
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xSTORED" },
    });
    await getPnLView(baseConfig);

    let stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");

    // Second sync — findOpenEvent returns not_found (simulate no-find), but DB fast-path should win
    mockFindOpenEvent = async () => ({ status: "not_found" });
    findOpenEventCallCount = 0;

    await getPnLView(baseConfig);

    // open_tx must still be the original value
    stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");

    // And findOpenEvent was NOT called (DB fast-path)
    expect(findOpenEventCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Helper: a closed (zero-liquidity) version of fakePos
// ---------------------------------------------------------------------------

const fakePosWithEntry = {
  token_id: TOKEN_ID,
  token0: fakePos.token0,
  token1: fakePos.token1,
  token0_symbol: "TOK",
  token1_symbol: "TOK",
  token0_decimals: 18,
  token1_decimals: 18,
  fee: fakePos.fee,
  tick_lower: fakePos.tickLower,
  tick_upper: fakePos.tickUpper,
  entry_sqrt_price_x96: "79228162514264337593543950336",
  entry_block: 100,
  entry_amount0: "1000",
  entry_amount1: "2000",
  entry_liquidity: "1000000",
  open_tx: "0xOPEN",
};

const fakePosZeroLiquidity = { ...fakePos, liquidity: 0n };

describe("close_tx persistence and exit cache bypass", () => {
  it("slow-path persists close data after findCloseEvent returns a result", async () => {
    // Use a zero-liquidity (closed) position
    mockGetAllPositions = async () => [fakePosZeroLiquidity];
    // Pre-seed entry data so the position is known
    upsertPosition({ ...fakePosWithEntry });

    mockFindCloseEvent = async () => ({
      status: "found",
      event: {
        tokenId: 42n,
        blockNumber: 5000n,
        transactionHash: "0xCLOSE",
        amount0: 100n,
        amount1: 200n,
        liquidity: 0n,
        collectedFees0: 10n,
        collectedFees1: 20n,
      },
    });

    await getPnLView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.close_tx).toBe("0xCLOSE");
    expect(stored!.exit_amount0).toBe("100");
    expect(stored!.exit_amount1).toBe("200");
    expect(stored!.fees_collected0).toBe("10");
    expect(stored!.fees_collected1).toBe("20");
    expect(stored!.close_block).toBe(5000);
  });

  it("exit cache bypass skips findCloseEvent when close_tx and exit_amount0 are stored", async () => {
    mockGetAllPositions = async () => [fakePosZeroLiquidity];
    upsertPosition({
      ...fakePosWithEntry,
      close_tx: "0xCACHED",
      exit_amount0: "999",
      exit_amount1: "888",
      fees_collected0: "7",
      fees_collected1: "8",
      close_block: 5000,
    });

    findCloseEventCallCount = 0;
    await getPnLView(baseConfig);

    expect(findCloseEventCallCount).toBe(0);
  });

  it("exit cache does not overwrite existing close data on second sync", async () => {
    mockGetAllPositions = async () => [fakePosZeroLiquidity];
    upsertPosition({
      ...fakePosWithEntry,
      close_tx: "0xCACHED",
      exit_amount0: "42",
      exit_amount1: "0",
      fees_collected0: "0",
      fees_collected1: "0",
      close_block: 5000,
    });

    // First sync
    await getPnLView(baseConfig);
    // Second sync
    await getPnLView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored!.close_tx).toBe("0xCACHED");
    expect(stored!.exit_amount0).toBe("42");
  });

  it("partial close cache (close_tx set but exit_amount0 is null) falls through to slow-path", async () => {
    mockGetAllPositions = async () => [fakePosZeroLiquidity];
    upsertPosition({
      ...fakePosWithEntry,
      close_tx: "0xPARTIAL",
      // exit_amount0 intentionally not set (null)
    });

    findCloseEventCallCount = 0;
    mockFindCloseEvent = async () => ({ status: "not_found" }); // returns not_found but must be called

    await getPnLView(baseConfig);

    expect(findCloseEventCallCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// pnl.ts caller — EventResult rpc_error propagation
// ---------------------------------------------------------------------------

describe("pnl.ts caller — EventResult rpc_error propagation", () => {
  it("rpc_error from findOpenEvent causes position to be skipped", async () => {
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("RPC down") });

    const result = await getPnLView(baseConfig);

    const ids = result.map((p: { tokenId: string }) => p.tokenId);
    expect(ids).not.toContain(TOKEN_ID);
  });

  it("rpc_error from findCloseEvent causes closed position to be skipped", async () => {
    mockGetAllPositions = async () => [fakePosZeroLiquidity];
    upsertPosition({ ...fakePosWithEntry });

    mockFindCloseEvent = async () => ({ status: "rpc_error", error: new Error("RPC timeout") });

    const result = await getPnLView(baseConfig);

    const ids = result.map((p: { tokenId: string }) => p.tokenId);
    expect(ids).not.toContain(TOKEN_ID);
  });
});
