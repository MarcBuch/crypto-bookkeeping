/**
 * Adversarial tests: open_tx persistence in getILView (il.ts)
 *
 * Cluster A: found → open_tx written to DB
 * Cluster B: not_found → position skipped, no DB row
 * Cluster C: hasStoredEntry fast-path → findOpenEvent never called, open_tx preserved
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockFindOpenEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findOpenEventCallCount = 0;

let mockFindCloseEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });

await mock.module("../chain/events.js", () => ({
  findOpenEvent: (...args: unknown[]) => {
    findOpenEventCallCount++;
    return mockFindOpenEvent(...args);
  },
  findCloseEvent: (...args: unknown[]) => mockFindCloseEvent(...args),
  getPoolPriceAtBlock: async () => null,
}));

await mock.module("../chain/client.js", () => ({
  createClient: () => ({
    getBlockNumber: async () => 1000n,
  }),
}));

await mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

await mock.module("../chain/hypersync.js", () => ({
  createHyperSyncClient: () => ({}),
  DEFAULT_HYPERSYNC_URL: "https://hyperliquid.hypersync.xyz",
}));

await mock.module("../chain/pools.js", () => ({
  getTokenInfo: async () => ({ symbol: "TOK", decimals: 18 }),
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099" as const,
  getPoolState: async () => ({
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }),
  computeUnclaimedFees: async () => ({ fees0: 0, fees1: 0 }),
}));

let mockGetAllPositions: () => unknown = async () => [];

await mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
}));

await mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => 79228162514264337593543950336n,
  getTokenAmounts: () => ({ amount0: 500n, amount1: 500n }),
  sqrtPriceX96ToPrice: () => 1.0,
  calculateDivergenceLoss: () => ({
    entryPrice: 1.0,
    currentPrice: 1.0,
    divergenceLossPercent: 0,
    valueLpInToken1: 1.0,
    valueHoldInToken1: 1.0,
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import { getPosition, upsertPosition } from "../db/store.js";
import { getILView } from "../services/il.js";
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
  transactionHash: "0xABC" as `0x${string}`,
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

// Reusable DB seed for a position with full entry data
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
  open_tx: "0xSTORED",
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
// Cluster A: found → open_tx written to DB
// ---------------------------------------------------------------------------

describe("Cluster A: found → open_tx stored", () => {
  it("writes open_tx to DB when findOpenEvent returns found", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xABC" },
    });

    await getILView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.open_tx).toBe("0xABC");
  });

  it("writes entry fields alongside open_tx", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xABC", blockNumber: 999n },
    });

    await getILView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.open_tx).toBe("0xABC");
    expect(stored!.entry_block).toBe(999);
    expect(stored!.entry_amount0).toBe("1000");
    expect(stored!.entry_amount1).toBe("2000");
    expect(stored!.entry_liquidity).toBe("1000000");
  });

  it("result contains the position view after open_tx is persisted", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xABC" },
    });

    const result = await getILView(baseConfig);

    expect(result).toHaveLength(1);
    expect(result[0].tokenId).toBe(TOKEN_ID);
  });
});

// ---------------------------------------------------------------------------
// Cluster B: not_found → position skipped, no DB row written
// ---------------------------------------------------------------------------

describe("Cluster B: not_found → nothing written", () => {
  it("does not write a DB row when findOpenEvent returns not_found", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    await getILView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored).toBeNull();
  });

  it("skips the position from the result when findOpenEvent returns not_found", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    const result = await getILView(baseConfig);

    expect(result).toHaveLength(0);
  });

  it("does not overwrite a pre-existing open_tx when findOpenEvent returns not_found", async () => {
    // Pre-seed a row without entry_sqrt_price_x96 but WITH open_tx
    upsertPosition({
      ...fakePosWithEntry,
      entry_sqrt_price_x96: null,
      open_tx: "0xPRE",
    });

    mockFindOpenEvent = async () => ({ status: "not_found" });

    await getILView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    // Position was skipped, so no upsert happened — open_tx must still be the original value
    expect(stored!.open_tx).toBe("0xPRE");
  });
});

// ---------------------------------------------------------------------------
// Cluster C: hasStoredEntry fast-path — findOpenEvent never called
// ---------------------------------------------------------------------------

describe("Cluster C: hasStoredEntry fast-path preserves open_tx", () => {
  it("does not call findOpenEvent when entry_sqrt_price_x96 is already in DB", async () => {
    upsertPosition({ ...fakePosWithEntry });

    findOpenEventCallCount = 0;

    await getILView(baseConfig);

    expect(findOpenEventCallCount).toBe(0);
  });

  it("preserves open_tx from DB when entry is already stored", async () => {
    upsertPosition({ ...fakePosWithEntry, open_tx: "0xSTORED" });

    await getILView(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");
  });

  it("second run with stored entry is idempotent — open_tx unchanged", async () => {
    // First run: slow-path discovers and persists open_tx
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xSTORED" },
    });
    await getILView(baseConfig);

    let stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");

    // Second run: DB fast-path — findOpenEvent is NOT called, open_tx stays
    mockFindOpenEvent = async () => ({ status: "not_found" });
    findOpenEventCallCount = 0;

    await getILView(baseConfig);

    stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");
    expect(findOpenEventCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rpc_error propagation
// ---------------------------------------------------------------------------

describe("rpc_error from findOpenEvent → position skipped", () => {
  it("skips the position and does not write to DB", async () => {
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("RPC down") });

    const result = await getILView(baseConfig);

    expect(result).toHaveLength(0);
    expect(getPosition(TOKEN_ID)).toBeNull();
  });
});
