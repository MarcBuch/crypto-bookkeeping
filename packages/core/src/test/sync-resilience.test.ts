/**
 * End-to-end sync resilience scenarios.
 *
 * These exercise the hardened sync path with the REAL `resolvePnLViewsDetailed`
 * (services/pnl.ts) and the REAL `resolvePositionLifecycle`
 * (services/position-lifecycle.ts). Only the chain boundary is mocked, so the
 * stored-first / failure-tolerant behaviour is what is actually under test.
 *
 *   A. Discovery endpoints down, eth_call up: stored facts save the day and
 *      pre-existing cache rows for an unresolved position survive untouched.
 *   B. A per-position math exception is isolated (one "failed", the other "ok").
 *   C. A total wallet-enumeration outage aborts before any cache write.
 *   D. The IL view tolerates an unresolved lifecycle instead of throwing.
 *
 * IMPORTANT: do NOT mock ../services/pnl.js here — the real loop must run.
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the modules under test
// ---------------------------------------------------------------------------

const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const TOKEN1 = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as `0x${string}`;
const TOKEN0_P1 = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as `0x${string}`;
const TOKEN0_P2 = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" as `0x${string}`;
const POOL_P1 = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const POOL_P2 = "0x2222222222222222222222222222222222222222" as `0x${string}`;

// --- chain/positions -------------------------------------------------------
let mockGetAllPositions: () => Promise<unknown> = async () => [];
await mock.module("../chain/positions.js", () => ({
  getAllPositions: (..._args: unknown[]) => mockGetAllPositions(),
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

// --- chain/events (the "discovery" seam) -----------------------------------
let mockFindOpenEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let mockFindCloseEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });
let findOpenEventTokenIds: string[] = [];
let findCloseEventTokenIds: string[] = [];

await mock.module("../chain/events.js", () => ({
  findOpenEvent: (...args: unknown[]) => {
    findOpenEventTokenIds.push(String(args[2]));
    return mockFindOpenEvent(...args);
  },
  findCloseEvent: (...args: unknown[]) => {
    findCloseEventTokenIds.push(String(args[2]));
    return mockFindCloseEvent(...args);
  },
  sumDecreaseLiquidityLogs: async () => ({ amount0: 0n, amount1: 0n }),
  sumCollectLogsPublic: async () => ({ amount0: 0n, amount1: 0n }),
  getPoolPriceAtBlock: async () => null,
}));

// --- chain/client ----------------------------------------------------------
const fakeClient = {
  getBlockNumber: async () => 1000n,
  getLogs: async () => [],
  getBlock: async (args?: { blockNumber?: bigint }) => ({
    number: args?.blockNumber ?? 0n,
    timestamp: 1_700_000_000n,
    hash: "0xblock",
  }),
};

await mock.module("../chain/client.js", () => ({
  createClient: () => fakeClient,
}));

// --- chain/rpc (retry passthrough) -----------------------------------------
await mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

// --- chain/pools (eth_call seam) -------------------------------------------
// `slot0ThrowsForPool` lets one scenario make `projectCurrentPosition` fail for
// a single pool while `getPoolState` (used by lifecycle resolution) still works.
let slot0ThrowsForPool: string | null = null;

await mock.module("../chain/pools.js", () => ({
  getTokenInfo: async (_client: unknown, token: string) =>
    token === TOKEN1 ? { symbol: "USDC", decimals: 6 } : { symbol: "WHYPE", decimals: 18 },
  getPoolAddress: async (_client: unknown, _factory: unknown, token0: string) =>
    token0 === TOKEN0_P1 ? POOL_P1 : POOL_P2,
  getSlot0: async (_client: unknown, poolAddress: string) => {
    if (slot0ThrowsForPool !== null && poolAddress === slot0ThrowsForPool) {
      throw new Error(`slot0 unavailable for pool ${poolAddress}`);
    }
    return { address: poolAddress, sqrtPriceX96: SQRT_PRICE_1_1, tick: 0 };
  },
  getPoolState: async () => ({
    sqrtPriceX96: SQRT_PRICE_1_1,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }),
  computeUnclaimedFeesRaw: async () => ({ fees0: 0n, fees1: 0n }),
  getTickData: async () => ({
    feeGrowthOutside0X128: 0n,
    feeGrowthOutside1X128: 0n,
  }),
}));

// --- math/divergence-loss (sane deterministic amounts) ---------------------
await mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => SQRT_PRICE_1_1,
  getTokenAmounts: () => ({ amount0: 500n, amount1: 500n }),
  sqrtPriceX96ToPrice: () => 1.0,
  tickToPrice: () => 1.0,
  calculateFeeGrowthInside: () => ({ feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n }),
  calculateUnclaimedFees: () => ({ fees0: 0, fees1: 0 }),
  calculateUnclaimedFeesRaw: () => ({ fees0: 0n, fees1: 0n }),
}));

// --- services/pricing (no live/historical USD in these tests) --------------
await mock.module("../services/pricing.js", () => ({
  getUsdPrices: async () => ({}),
  getHistoricalPrice: async () => null,
}));

// --- services/hedge (LP sync must not touch Hyperliquid) -------------------
await mock.module("../services/hedge.js", () => ({
  getHedgeView: async () => {
    throw new Error("hedge view not expected in sync-resilience tests");
  },
  snapshotHedge: () => {},
  syncHyperliquidHedgeTrades: async () => 0,
}));

// --- services/lp-economics (the per-position math seam) --------------------
// Scenario B makes this throw for a single tokenId inside the pnl loop.
let economicsThrowTokenId: bigint | null = null;

function fakeCalculateLpEconomics(facts: { pos?: { tokenId?: bigint } }): Record<string, number> {
  if (economicsThrowTokenId !== null && facts.pos?.tokenId === economicsThrowTokenId) {
    throw new Error(`economics exploded for #${facts.pos.tokenId}`);
  }
  return {
    entryAmount0: 1,
    entryAmount1: 1,
    exitAmount0: 1,
    exitAmount1: 1,
    pendingFees0: 0,
    pendingFees1: 0,
    totalFees0: 0,
    totalFees1: 0,
    entryPrice: 1,
    exitPrice: 1,
    priceChangePercent: 0,
    entryValueInToken1: 2,
    exitValueInToken1: 3,
    holdValueInToken1: 2,
    pendingFeesValueInToken1: 0,
    totalFeesValueInToken1: 0,
    absolutePnlInToken1: 1,
    absolutePnlPercent: 0.5,
    divergenceLossPercent: 0,
    opportunityCostInToken1: 0,
    netVsHodlInToken1: 1,
    netVsHodlPercent: 0.5,
    priceLower: 0.5,
    priceUpper: 2,
  };
}

await mock.module("../services/lp-economics.js", () => ({
  calculateLpEconomics: (facts: { pos?: { tokenId?: bigint } }) => fakeCalculateLpEconomics(facts),
}));

// ---------------------------------------------------------------------------
// Module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import { getDb } from "../db/schema.js";
import {
  listCachedPositionViews,
  listCachedPnLViews,
  listLpSyncOutcomes,
  upsertPosition,
  upsertPositionViewCache,
  upsertPnLViewCache,
} from "../db/store.js";
import { getILView } from "../services/il.js";
import type { SyncLpDataSummary } from "../services/positions.js";
import { syncLpData } from "../services/positions.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const P1_ID = "101";
const P2_ID = "202";

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

function makeRawPosition(tokenId: bigint, token0: `0x${string}`, liquidity: bigint) {
  return {
    tokenId,
    nonce: 0n,
    operator: ZERO_ADDRESS,
    token0,
    token1: TOKEN1,
    fee: 3000,
    tickLower: -100,
    tickUpper: 100,
    liquidity,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
  };
}

// P1 is a closed NFT (liquidity 0) with fully stored entry + exit facts.
const RAW_P1 = makeRawPosition(101n, TOKEN0_P1, 0n);
// P2 is an active NFT with no stored facts.
const RAW_P2 = makeRawPosition(202n, TOKEN0_P2, 1_000_000n);

function storedEntry(tokenId: string, token0: `0x${string}`, openTx: string) {
  return {
    token_id: tokenId,
    token0,
    token1: TOKEN1,
    token0_symbol: "WHYPE",
    token1_symbol: "USDC",
    token0_decimals: 18,
    token1_decimals: 6,
    fee: 3000,
    tick_lower: -100,
    tick_upper: 100,
    entry_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
    entry_block: 100,
    entry_amount0: "1000",
    entry_amount1: "2000",
    entry_liquidity: "1000000",
    open_tx: openTx,
  };
}

const storedClosedExit = {
  close_tx: "0xSTORED_CLOSE",
  exit_amount0: "130",
  exit_amount1: "260",
  fees_collected0: "10",
  fees_collected1: "20",
  close_block: 5000,
  exit_sqrt_price_x96: SQRT_PRICE_1_1.toString(),
  close_usd_price0: 2.0,
  close_usd_price1: 1.0,
};

const PRE_SYNCED_AT = "2026-01-01T00:00:00.000Z";

function makePositionViewRow(tokenId: string) {
  return {
    tokenId,
    token0: { address: TOKEN0_P1, symbol: "WHYPE", decimals: 18 },
    token1: { address: TOKEN1, symbol: "USDC", decimals: 6 },
    fee: 3000,
    feePercent: 0.3,
    tickLower: -100,
    tickUpper: 100,
    priceLower: 0.5,
    priceUpper: 2,
    currentPrice: 1,
    liquidity: "1000000",
    status: "active",
    inRange: true,
    currentAmount0: 1,
    currentAmount1: 1,
  };
}

function makePnLViewRow(tokenId: string) {
  return {
    tokenId,
    pair: "WHYPE/USDC",
    token0Symbol: "WHYPE",
    token1Symbol: "USDC",
    status: "active",
    entryPrice: 1,
    exitPrice: 1,
    divergenceLossPercent: 0,
  };
}

function readSyncedAt(
  table: "positions_view_cache" | "pnl_view_cache",
  tokenId: string,
): string | null {
  return (
    getDb()
      .query<{ synced_at: string }, [string]>(`SELECT synced_at FROM ${table} WHERE token_id = ?`)
      .get(tokenId)?.synced_at ?? null
  );
}

function preSeedCacheRow(tokenId: string): void {
  upsertPositionViewCache(tokenId, makePositionViewRow(tokenId), PRE_SYNCED_AT);
  upsertPnLViewCache(tokenId, makePnLViewRow(tokenId), PRE_SYNCED_AT);
}

function outcomeFor(summary: SyncLpDataSummary, tokenId: string) {
  return summary.outcomes.find((outcome) => outcome.tokenId === tokenId);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  mockGetAllPositions = async () => [];
  mockFindOpenEvent = async () => ({ status: "not_found" });
  mockFindCloseEvent = async () => ({ status: "not_found" });
  findOpenEventTokenIds = [];
  findCloseEventTokenIds = [];
  slot0ThrowsForPool = null;
  economicsThrowTokenId = null;
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Scenario A — discovery down, eth_call up, stored facts save the day
// ---------------------------------------------------------------------------

function configureScenarioA(): void {
  mockGetAllPositions = async () => [RAW_P1, RAW_P2];
  // `getSlot0` fails for P2's pool, so P2 is skipped from the point-in-time
  // positions cache write; lifecycle resolution for P2 still runs (it uses
  // getPoolState) and degrades to "pending" via event-discovery rpc_error.
  slot0ThrowsForPool = POOL_P2;
  mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("discovery down") });
  mockFindCloseEvent = async () => ({ status: "rpc_error", error: new Error("discovery down") });
}

const scenarioAConfig = {
  ...baseConfig,
  positions: {
    [P1_ID]: { openTx: "0xCONFIG_OPEN", closeTx: "0xCONFIG_CLOSE" },
  },
};

describe("sync resilience — A: discovery down, eth_call up, stored facts", () => {
  it("resolves with ok for stored P1 and pending for factless P2", async () => {
    upsertPosition({ ...storedEntry(P1_ID, TOKEN0_P1, "0xSTORED_OPEN"), ...storedClosedExit });
    configureScenarioA();

    const summary = await syncLpData(scenarioAConfig);

    expect(outcomeFor(summary, P1_ID)?.outcome).toBe("ok");
    expect(outcomeFor(summary, P1_ID)?.entrySource).toBe("stored");
    expect(outcomeFor(summary, P1_ID)?.exitSource).toBe("stored");
    expect(outcomeFor(summary, P2_ID)?.outcome).toBe("pending");

    // One lp_sync_outcomes row per wallet position.
    const stored = listLpSyncOutcomes();
    const byId = new Map(stored.map((row) => [row.tokenId, row]));
    expect(byId.size).toBe(2);
    expect(byId.get(P1_ID)?.outcome).toBe("ok");
    expect(byId.get(P2_ID)?.outcome).toBe("pending");
  });

  it("produces and upserts P1's pnl view", async () => {
    upsertPosition({ ...storedEntry(P1_ID, TOKEN0_P1, "0xSTORED_OPEN"), ...storedClosedExit });
    configureScenarioA();

    await syncLpData(scenarioAConfig);

    const pnl = listCachedPnLViews();
    expect(pnl.some((row) => row.tokenId === P1_ID)).toBe(true);
    // P2 never produced a view, so it must not have been rewritten.
    expect(pnl.some((row) => row.tokenId === P2_ID)).toBe(false);
  });

  it("preserves P2's pre-existing cache rows with their original synced_at in BOTH tables", async () => {
    upsertPosition({ ...storedEntry(P1_ID, TOKEN0_P1, "0xSTORED_OPEN"), ...storedClosedExit });
    preSeedCacheRow(P2_ID);
    configureScenarioA();

    await syncLpData(scenarioAConfig);

    expect(readSyncedAt("positions_view_cache", P2_ID)).toBe(PRE_SYNCED_AT);
    expect(readSyncedAt("pnl_view_cache", P2_ID)).toBe(PRE_SYNCED_AT);
    expect(listCachedPositionViews().some((row) => row.tokenId === P2_ID)).toBe(true);
    expect(listCachedPnLViews().some((row) => row.tokenId === P2_ID)).toBe(true);
  });

  it("resolves P1 entirely from storage with ZERO event-discovery calls for its tokenId", async () => {
    upsertPosition({ ...storedEntry(P1_ID, TOKEN0_P1, "0xSTORED_OPEN"), ...storedClosedExit });
    configureScenarioA();

    await syncLpData(scenarioAConfig);

    expect(findOpenEventTokenIds).not.toContain(P1_ID);
    expect(findCloseEventTokenIds).not.toContain(P1_ID);
    // P2 (no stored facts) is the only position that went to discovery.
    expect(findOpenEventTokenIds).toContain(P2_ID);
  });
});

// ---------------------------------------------------------------------------
// Scenario B — per-position exception isolation
// ---------------------------------------------------------------------------

describe("sync resilience — B: per-position exception isolation", () => {
  function configureScenarioB(): void {
    mockGetAllPositions = async () => [
      makeRawPosition(101n, TOKEN0_P1, 1_000_000n),
      makeRawPosition(202n, TOKEN0_P2, 1_000_000n),
    ];
    upsertPosition({ ...storedEntry(P1_ID, TOKEN0_P1, "0xB_OPEN_1") });
    upsertPosition({ ...storedEntry(P2_ID, TOKEN0_P2, "0xB_OPEN_2") });
    economicsThrowTokenId = 101n;
  }

  it("resolves (does not reject) and records failed for P1, ok for P2", async () => {
    configureScenarioB();

    const summary = await syncLpData(baseConfig);

    expect(outcomeFor(summary, P1_ID)?.outcome).toBe("failed");
    expect(outcomeFor(summary, P1_ID)?.error).toContain("economics exploded for #101");
    expect(outcomeFor(summary, P2_ID)?.outcome).toBe("ok");
  });

  it("upserts P2's view while P1's pre-seeded pnl cache row survives", async () => {
    preSeedCacheRow(P1_ID);
    configureScenarioB();

    await syncLpData(baseConfig);

    const pnl = listCachedPnLViews();
    // P2 got a fresh view…
    const p2 = pnl.find((row) => row.tokenId === P2_ID);
    expect(p2).toBeDefined();
    // …and P1's previous row is untouched (same content and synced_at).
    expect(readSyncedAt("pnl_view_cache", P1_ID)).toBe(PRE_SYNCED_AT);
    expect(readSyncedAt("pnl_view_cache", P2_ID)).not.toBe(PRE_SYNCED_AT);
  });
});

// ---------------------------------------------------------------------------
// Scenario C — total outage fails cleanly with zero data loss
// ---------------------------------------------------------------------------

describe("sync resilience — C: total outage, zero data loss", () => {
  it("rejects when wallet enumeration fails and leaves both cache tables untouched", async () => {
    preSeedCacheRow(P1_ID);
    preSeedCacheRow(P2_ID);

    mockGetAllPositions = async () => {
      throw new Error("wallet enumeration RPC down");
    };

    await expect(syncLpData(baseConfig)).rejects.toThrow("wallet enumeration RPC down");

    for (const table of ["positions_view_cache", "pnl_view_cache"] as const) {
      expect(readSyncedAt(table, P1_ID)).toBe(PRE_SYNCED_AT);
      expect(readSyncedAt(table, P2_ID)).toBe(PRE_SYNCED_AT);
    }
    expect(listCachedPositionViews()).toHaveLength(2);
    expect(listCachedPnLViews()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario D — IL flow tolerates unresolved lifecycle
// ---------------------------------------------------------------------------

describe("sync resilience — D: IL tolerates an unresolved lifecycle", () => {
  it("does not throw and omits the unresolved position from the IL result", async () => {
    mockGetAllPositions = async () => [RAW_P2];
    mockFindOpenEvent = async () => ({ status: "rpc_error", error: new Error("discovery down") });

    const result = await getILView(baseConfig);

    expect(result).toEqual([]);
  });
});
