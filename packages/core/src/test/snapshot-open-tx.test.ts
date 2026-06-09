/**
 * Adversarial tests: open_tx persistence in snapshot.ts
 *
 * Cluster A: found → open_tx stored
 * Cluster B: not_found → fallback used, open_tx NOT written by findOpenEvent
 * Cluster C: second run idempotent (open_tx preserved, findOpenEvent NOT called)
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockFindOpenEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findOpenEventCallCount = 0;

mock.module("../chain/events.js", () => ({
  findOpenEvent: (...args: unknown[]) => {
    findOpenEventCallCount++;
    return mockFindOpenEvent(...args);
  },
  findCloseEvent: async () => ({ status: "not_found" }),
  getPoolPriceAtBlock: async () => null,
}));

mock.module("../chain/client.js", () => ({
  createClient: () => ({
    getBlockNumber: async () => 1000n,
  }),
}));

mock.module("../chain/hypersync.js", () => ({
  createHyperSyncClient: () => ({}),
  DEFAULT_HYPERSYNC_URL: "https://hypersync.example.com",
}));

mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

// Pool state mock — sqrtPriceX96 represents price ≈ 1 (1:1 ratio)
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

mock.module("../chain/pools.js", () => ({
  getTokenInfo: async () => ({ symbol: "TOK", decimals: 18 }),
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099" as const,
  getPoolState: async () => ({
    sqrtPriceX96: SQRT_PRICE_1_1,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }),
  computeUnclaimedFees: async () => ({ fees0: 0, fees1: 0 }),
  getTickData: async () => ({
    feeGrowthOutside0X128: 0n,
    feeGrowthOutside1X128: 0n,
  }),
  buildPoolCacheKey: (t0: string, t1: string, fee: number) =>
    `${t0.toLowerCase()}:${t1.toLowerCase()}:${fee}`,
}));

let mockGetAllPositions: () => unknown = async () => [];

mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => SQRT_PRICE_1_1,
  getTokenAmounts: () => ({ amount0: 500000000000000000n, amount1: 500000000000000000n }),
  sqrtPriceX96ToPrice: () => 1.0,
  calculateFeeGrowthInside: () => ({
    feeGrowthInside0X128: 0n,
    feeGrowthInside1X128: 0n,
  }),
  calculateUnclaimedFees: () => ({ fees0: 0, fees1: 0 }),
}));

// ---------------------------------------------------------------------------
// Import module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import { getPosition, upsertPosition } from "../db/store.js";
import { takeSnapshot } from "../services/snapshot.js";
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
  transactionHash: "0xSNAP",
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
  mockGetAllPositions = async () => [fakePos];
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Cluster A: found → open_tx stored
// ---------------------------------------------------------------------------

describe("Cluster A: findOpenEvent found → open_tx stored in DB", () => {
  it("stores open_tx when findOpenEvent returns status=found", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xSNAP" },
    });

    const results = await takeSnapshot(baseConfig);

    // Snapshot must be saved
    expect(results).toHaveLength(1);
    expect(results[0].saved).toBe(true);

    // DB must have open_tx
    const stored = getPosition(TOKEN_ID);
    expect(stored).not.toBeNull();
    expect(stored!.open_tx).toBe("0xSNAP");
  });

  it("stores the exact transactionHash from the open event (not a default)", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xABCDEF1234567890" },
    });

    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xABCDEF1234567890");
  });

  it("also persists entry_sqrt_price_x96 alongside open_tx", async () => {
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xSNAP" },
    });

    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSNAP");
    // entry_sqrt_price_x96 must also be persisted (deriveEntryPriceFromAmounts mock returns SQRT_PRICE_1_1)
    expect(stored!.entry_sqrt_price_x96).toBe(SQRT_PRICE_1_1.toString());
  });
});

// ---------------------------------------------------------------------------
// Cluster B: not_found → fallback used, open_tx NOT written
// ---------------------------------------------------------------------------

describe("Cluster B: findOpenEvent not_found → fallback, open_tx stays null", () => {
  it("snapshot still saved when findOpenEvent returns not_found", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    const results = await takeSnapshot(baseConfig);

    // Snapshot should be saved using fallback price
    expect(results).toHaveLength(1);
    expect(results[0].saved).toBe(true);
  });

  it("open_tx remains null when findOpenEvent returns not_found", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    // The not_found path does NOT write a position row at all (no persistPositionEntry call),
    // so stored can be null — either way, open_tx must not be "0xSNAP"
    const openTx = stored?.open_tx ?? null;
    expect(openTx).toBeNull();
  });

  it("pre-seeded open_tx is unchanged when not_found path runs", async () => {
    // Pre-seed position WITHOUT entry_sqrt_price_x96 so fallback path is reached
    // but with an open_tx already written by a prior run
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
      entry_sqrt_price_x96: null,
      entry_block: null,
      entry_amount0: null,
      entry_amount1: null,
      entry_liquidity: null,
      open_tx: "0xPREVIOUS",
    });

    mockFindOpenEvent = async () => ({ status: "not_found" });

    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    // upsertPosition uses COALESCE so existing open_tx is preserved
    expect(stored!.open_tx).toBe("0xPREVIOUS");
  });
});

// ---------------------------------------------------------------------------
// Cluster C: second run idempotent (open_tx preserved, findOpenEvent not called)
// ---------------------------------------------------------------------------

describe("Cluster C: hasStoredEntry path — findOpenEvent never called, open_tx preserved", () => {
  it("does not call findOpenEvent when position already has entry_sqrt_price_x96", async () => {
    // Pre-seed the DB with complete entry data (simulates a prior snapshot run)
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
      entry_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
      entry_block: 100,
      entry_amount0: "1000",
      entry_amount1: "2000",
      entry_liquidity: "1000000",
      open_tx: "0xSTORED",
    });

    findOpenEventCallCount = 0;

    await takeSnapshot(baseConfig);

    expect(findOpenEventCallCount).toBe(0);
  });

  it("open_tx is preserved on second run (DB fast-path wins)", async () => {
    // Pre-seed with open_tx already stored
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
      entry_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
      entry_block: 100,
      entry_amount0: "1000",
      entry_amount1: "2000",
      entry_liquidity: "1000000",
      open_tx: "0xSTORED",
    });

    // Run twice to confirm idempotency
    await takeSnapshot(baseConfig);
    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored!.open_tx).toBe("0xSTORED");
  });

  it("findOpenEvent not called on SECOND run after first run stored open_tx", async () => {
    // First run: slow path discovers and writes open_tx
    mockFindOpenEvent = async () => ({
      status: "found",
      event: { ...fakeOpenEvent, transactionHash: "0xFIRST" },
    });

    await takeSnapshot(baseConfig);

    const afterFirst = getPosition(TOKEN_ID);
    expect(afterFirst!.open_tx).toBe("0xFIRST");

    // Second run: DB has entry_sqrt_price_x96 now, so findOpenEvent must NOT be called
    findOpenEventCallCount = 0;
    mockFindOpenEvent = async () => ({ status: "not_found" }); // would corrupt if called

    await takeSnapshot(baseConfig);

    expect(findOpenEventCallCount).toBe(0);

    // open_tx must still be the original
    const afterSecond = getPosition(TOKEN_ID);
    expect(afterSecond!.open_tx).toBe("0xFIRST");
  });

  it("snapshot still saved on second run (fast-path does not skip snapshot)", async () => {
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
      entry_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
      entry_block: 100,
      entry_amount0: "1000",
      entry_amount1: "2000",
      entry_liquidity: "1000000",
      open_tx: "0xSTORED",
    });

    const results = await takeSnapshot(baseConfig);
    expect(results).toHaveLength(1);
    expect(results[0].saved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge case: rpc_error causes position to be skipped without writing open_tx
// ---------------------------------------------------------------------------

describe("Edge: rpc_error from findOpenEvent — position skipped, no DB write", () => {
  it("returns empty results when findOpenEvent returns rpc_error", async () => {
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("RPC down") });

    const results = await takeSnapshot(baseConfig);

    // Position should be skipped (continue statement in snapshot.ts)
    const ids = results.map((r) => r.tokenId);
    expect(ids).not.toContain(TOKEN_ID);
  });

  it("does not write open_tx when rpc_error occurs", async () => {
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("timeout") });

    await takeSnapshot(baseConfig);

    const stored = getPosition(TOKEN_ID);
    expect(stored?.open_tx ?? null).toBeNull();
  });
});
