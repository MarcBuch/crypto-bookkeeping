/**
 * Stored-first lifecycle resolution semantics.
 *
 * Persisted SQLite facts are the ledger of record: RPC discovery only fills gaps,
 * and discovery failures degrade to stored/pending states with warnings instead
 * of skipping positions.
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockFindOpenEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let mockFindCloseEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findOpenEventCallCount = 0;
let findCloseEventCallCount = 0;

await mock.module("../chain/events.js", () => ({
  findOpenEvent: (...args: unknown[]) => {
    findOpenEventCallCount++;
    return mockFindOpenEvent(...args);
  },
  findCloseEvent: (...args: unknown[]) => {
    findCloseEventCallCount++;
    return mockFindCloseEvent(...args);
  },
  sumDecreaseLiquidityLogs: async () => ({ amount0: 0n, amount1: 0n }),
  sumCollectLogsPublic: async () => ({ amount0: 0n, amount1: 0n }),
  getPoolPriceAtBlock: async () => null,
}));

const fakeClient = {
  getBlockNumber: async () => 1000n,
  getLogs: async () => [],
};

await mock.module("../chain/client.js", () => ({
  createClient: () => fakeClient,
}));

await mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
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
  computeUnclaimedFeesRaw: async () => ({ fees0: 0n, fees1: 0n }),
}));

await mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => 79228162514264337593543950336n,
  getTokenAmounts: () => ({ amount0: 500n, amount1: 500n }),
  sqrtPriceX96ToPrice: () => 1.0,
}));

// ---------------------------------------------------------------------------
// Import module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import type { Config } from "../config.js";
import { upsertPosition } from "../db/store.js";
import {
  createPositionLifecycleContext,
  resolvePositionLifecycle,
} from "../services/position-lifecycle.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN_ID = "42";
const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

const token0 = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`;
const token1 = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as `0x${string}`;

const activePos = {
  tokenId: 42n,
  nonce: 0n,
  operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  token0,
  token1,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 1000000n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

const closedPos = { ...activePos, liquidity: 0n };

const baseConfig: Config = {
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

const storedEntry = {
  token_id: TOKEN_ID,
  token0,
  token1,
  token0_symbol: "TOK",
  token1_symbol: "TOK",
  token0_decimals: 18,
  token1_decimals: 18,
  fee: activePos.fee,
  tick_lower: activePos.tickLower,
  tick_upper: activePos.tickUpper,
  entry_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
  entry_block: 100,
  entry_amount0: "1000",
  entry_amount1: "2000",
  entry_liquidity: "1000000",
  open_tx: "0xOPEN",
};

const storedExit = {
  ...storedEntry,
  close_tx: "0xCLOSE",
  exit_amount0: "130",
  exit_amount1: "260",
  fees_collected0: "10",
  fees_collected1: "20",
  close_block: 5000,
  exit_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
};

function makeContext(positions?: Config["positions"]) {
  return createPositionLifecycleContext({ ...baseConfig, positions });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  findOpenEventCallCount = 0;
  findCloseEventCallCount = 0;
  mockFindOpenEvent = async () => ({ status: "not_found" });
  mockFindCloseEvent = async () => ({ status: "not_found" });
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Stored-first entry / exit
// ---------------------------------------------------------------------------

describe("stored-first lifecycle resolution", () => {
  it("uses stored entry facts over a configured openTx with zero open-event RPC calls", async () => {
    upsertPosition({ ...storedEntry });

    const result = await resolvePositionLifecycle(
      await makeContext({ [TOKEN_ID]: { openTx: "0xCONFIG" } }),
      activePos,
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.entrySource).toBe("stored");
    expect(result.exitSource).toBe("active");
    expect(result.stale).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(findOpenEventCallCount).toBe(0);
  });

  it("uses stored exit facts over a configured closeTx with zero close-event RPC calls", async () => {
    upsertPosition({ ...storedExit });

    const result = await resolvePositionLifecycle(
      await makeContext({ [TOKEN_ID]: { openTx: "0xCONFIG", closeTx: "0xCONFIG_CLOSE" } }),
      closedPos,
    );

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.entrySource).toBe("stored");
    expect(result.exitSource).toBe("stored");
    expect(result.stale).toBe(false);
    expect(findOpenEventCallCount).toBe(0);
    expect(findCloseEventCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Degraded discovery
// ---------------------------------------------------------------------------

describe("failure-tolerant discovery", () => {
  it("returns unresolved (not skip / rpc_error) when entry discovery fails with no stored facts", async () => {
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("RPC down") });

    const result = await resolvePositionLifecycle(await makeContext(), activePos);

    expect(result.status).toBe("unresolved");
    if (result.status !== "unresolved") return;
    expect(result.reason).toBe("entry_rpc_error");
    expect(result.stale).toBe(true);
    expect(result.warnings.some((w) => w.includes("RPC down"))).toBe(true);
  });

  it("degrades to a stale zeroed exit when close discovery fails but stored entry exists", async () => {
    upsertPosition({ ...storedEntry });
    mockFindCloseEvent = async () => ({ status: "rpc_error", error: new Error("RPC timeout") });

    const result = await resolvePositionLifecycle(await makeContext(), closedPos);

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.entrySource).toBe("stored");
    expect(result.exitSource).toBe("unresolved");
    expect(result.stale).toBe(true);
    expect(result.warnings.some((w) => w.includes("RPC timeout"))).toBe(true);
    expect(result.facts.exitAmount0).toBe(0n);
    expect(result.facts.exitAmount1).toBe(0n);
  });

  it("falls back to current amounts for an active position when entry discovery fails", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    const result = await resolvePositionLifecycle(await makeContext(), activePos, {
      entryFallback: "current_amounts",
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.entrySource).toBe("unresolved");
    expect(result.stale).toBe(true);
    expect(result.facts.entryResolution).toBe("fallback_current_amounts");
  });

  it("does not fall back for a closed position when entry discovery fails", async () => {
    mockFindOpenEvent = async () => ({ status: "not_found" });

    const result = await resolvePositionLifecycle(await makeContext(), closedPos, {
      entryFallback: "current_amounts",
    });

    expect(result.status).toBe("unresolved");
  });
});
