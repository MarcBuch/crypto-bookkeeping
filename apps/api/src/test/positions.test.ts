import { describe, it, expect, beforeAll } from "bun:test";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";
import { installCoreMock } from "./core-mock.js";

// --- Minimal fake config (no real config.json needed) ---
const fakeConfig = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeef",
  contracts: {
    factory: "0x0000000000000000000000000000000000000001",
    positionManager: "0x0000000000000000000000000000000000000002",
    quoter: "0x0000000000000000000000000000000000000003",
    swapRouter: "0x0000000000000000000000000000000000000004",
  },
  positions: {
    "123": {
      openTx: "0x123abc",
      hedge: {
        coin: "HYPE",
      },
    },
    "456": {
      openTx: "0x456def",
    },
  },
} satisfies Config;

// --- Minimal fake PositionView objects ---
const fakePosition = {
  tokenId: "123",
  token0: { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
  token1: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  fee: 3000,
  feePercent: 0.3,
  tickLower: -887272,
  tickUpper: 887272,
  priceLower: 1000,
  priceUpper: 5000,
  currentPrice: 2000,
  liquidity: "1000000000000000000",
  status: "active" as const,
  inRange: true,
  currentAmount0: 1.5,
  currentAmount1: 3000,
};

const fakePosition2 = {
  ...fakePosition,
  tokenId: "456",
};

const fakePosition3 = {
  ...fakePosition,
  tokenId: "12",
};

const fakePosition4 = {
  ...fakePosition,
  tokenId: "7",
};

const fakePosition5 = {
  ...fakePosition,
  tokenId: "99",
};

// --- Standalone MockRpcError for use in tests (also used as RpcError in the mock) ---
class MockRpcError extends Error {
  code?: number;
  constructor(msg: string, code?: number) {
    super(msg);
    this.name = "RpcError";
    this.code = code;
  }
}

// --- Mutable mock function references ---
let mockListCachedPositionViews: (...args: unknown[]) => unknown = () => [];
let mockListCachedPnLViews: (...args: unknown[]) => unknown = () => [];
let mockGetPositionsCacheSyncedAt: (...args: unknown[]) => unknown = () => null;
let mockSyncLpData: (...args: unknown[]) => unknown = async () => ({ synced: 0 });
let mockSyncSinglePosition: (config: unknown, tokenId: string) => Promise<unknown> = async () => ({
  tokenId: "42",
  syncedAt: new Date().toISOString(),
});

function expectJson(response: { json(): unknown }) {
  return expect(response.json());
}

// --- Mock @lp-tracker/core BEFORE importing server ---
await installCoreMock({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: (...args: unknown[]) => mockListCachedPositionViews(...args),
  listCachedPnLViews: (...args: unknown[]) => mockListCachedPnLViews(...args),
  getPositionsCacheSyncedAt: (...args: unknown[]) => mockGetPositionsCacheSyncedAt(...args),
  syncLpData: (...args: unknown[]) => mockSyncLpData(...args),
  syncSinglePosition: (config: unknown, tokenId: string) => mockSyncSinglePosition(config, tokenId),
  getPnLView: async () => [],
  getILView: async () => [],
  getHistoryView: async () => [],
  getHedgeView: async () => ({
    tokenId: "42",
    coin: "HYPE",
    szi: "0",
    entryPx: 0,
    markPx: 0,
    unrealizedPnl: 0,
    fundingEarned: 0,
    liquidationPx: null,
    leverage: { type: "cross", value: 1 },
    status: "closed",
    realizedPnl: null,
    closedAt: null,
    closeReason: null,
  }),
  getHedgeEvents: async () => [],
  listHedgeEvents: () => [],
  assignHedgeEvent: () => null,
  listTaxTransactions: () => [],
  syncTaxTransactions: async () => ({}),
  createManualTaxTransaction: () => null,
  updateTaxTransaction: () => null,
  enrichTaxTransactionsEurValues: async () => ({ enriched: 0, skipped: 0 }),
  NotFoundError: class NotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "NotFoundError";
    }
  },
  RpcError: MockRpcError,
  ValidationError: class ValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "ValidationError";
    }
  },
});

let server: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import("../index.js");
  server = await buildServer(fakeConfig);
  await server.ready();
});

// ---------------------------------------------------------------------------
// GET /positions
// ---------------------------------------------------------------------------
describe("GET /positions", () => {
  it("returns 200 with empty array when no positions exist", async () => {
    mockListCachedPositionViews = () => [];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ positions: [] });
  });

  it("returns 200 with 2 positions", async () => {
    mockListCachedPositionViews = () => [fakePosition, fakePosition2];
    mockListCachedPnLViews = () => [
      { tokenId: "123", openedAt: "2026-02-01T00:00:00.000Z" },
      { tokenId: "456", openedAt: "2026-01-01T00:00:00.000Z" },
    ];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(2);
    expect(body.positions[0].tokenId).toBe("123");
    expect(body.positions[1].tokenId).toBe("456");
  });

  it("sorts by cached PnL openedAt newest first", async () => {
    mockListCachedPositionViews = () => [
      { ...fakePosition, tokenId: "1" },
      { ...fakePosition2, tokenId: "2" },
      { ...fakePosition3, tokenId: "3" },
    ];
    mockListCachedPnLViews = () => [
      { tokenId: "1", openedAt: "2026-01-01T00:00:00.000Z" },
      { tokenId: "2", openedAt: "2026-03-01T00:00:00.000Z" },
      { tokenId: "3", openedAt: "2026-02-01T00:00:00.000Z" },
    ];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().positions.map((position: { tokenId: string }) => position.tokenId)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });

  it("puts missing, null, or invalid openedAt last and tie-breaks equal timestamps by tokenId ascending", async () => {
    mockListCachedPositionViews = () => [
      { ...fakePosition4, tokenId: "10" },
      { ...fakePosition5, tokenId: "2" },
      { ...fakePosition, tokenId: "20" },
      { ...fakePosition3, tokenId: "11" },
      { ...fakePosition2, tokenId: "3" },
      { ...fakePosition5, tokenId: "99" },
    ];
    mockListCachedPnLViews = () => [
      { tokenId: "10", openedAt: "2026-04-01T00:00:00.000Z" },
      { tokenId: "2", openedAt: "2026-04-01T00:00:00.000Z" },
      { tokenId: "20", openedAt: "not-a-date" },
      { tokenId: "11", openedAt: "2026-05-01T00:00:00.000Z" },
      { tokenId: "3", openedAt: null },
      { tokenId: "99", openedAt: undefined },
    ];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().positions.map((position: { tokenId: string }) => position.tokenId)).toEqual([
      "11",
      "2",
      "10",
      "3",
      "20",
      "99",
    ]);
  });

  it("uses deterministic plain-string tie-breaks when tokenIds differ only by numeric-aware ordering", async () => {
    mockListCachedPositionViews = () => [
      { ...fakePosition, tokenId: "2" },
      { ...fakePosition2, tokenId: "10" },
      { ...fakePosition3, tokenId: "a2" },
      { ...fakePosition4, tokenId: "a10" },
    ];
    mockListCachedPnLViews = () => [
      { tokenId: "2", openedAt: "2026-04-01T00:00:00.000Z" },
      { tokenId: "10", openedAt: "2026-04-01T00:00:00.000Z" },
      { tokenId: "a2", openedAt: "2026-04-01T00:00:00.000Z" },
      { tokenId: "a10", openedAt: "2026-04-01T00:00:00.000Z" },
    ];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().positions.map((position: { tokenId: string }) => position.tokenId)).toEqual([
      "2",
      "10",
      "a2",
      "a10",
    ]);
  });

  it("attaches configured hedge metadata to matching positions only", async () => {
    mockListCachedPositionViews = () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions[0]).toMatchObject({
      tokenId: "123",
      hedge: { coin: "HYPE" },
    });
    expect(body.positions[1].hedge).toBeUndefined();
  });

  it("includes syncedAt field in response", async () => {
    mockListCachedPositionViews = () => [];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("syncedAt");
  });

  it("returns 200 with empty positions array and null syncedAt when cache is empty", async () => {
    mockListCachedPositionViews = () => [];
    mockGetPositionsCacheSyncedAt = () => null;

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toEqual([]);
    expect(body.syncedAt).toBeNull();
  });

  it("includes syncedAt in list response when cache has been synced", async () => {
    mockListCachedPositionViews = () => [fakePosition];
    mockGetPositionsCacheSyncedAt = () => "2026-06-01T20:00:00.000Z";

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncedAt).toBe("2026-06-01T20:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId", () => {
  it("returns 400 for non-numeric tokenId (letters only)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for mixed alphanumeric tokenId", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc123" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 404 when no position matches tokenId", async () => {
    mockListCachedPositionViews = () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
  });

  it("returns 200 with matching position", async () => {
    mockListCachedPositionViews = () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions/123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ position: { tokenId: "123" } });
  });

  it("returns configured hedge metadata on single-position reads", async () => {
    mockListCachedPositionViews = () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions/123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      position: {
        tokenId: "123",
        hedge: { coin: "HYPE" },
      },
    });
  });

  it("accepts very large numeric string tokenId → 404 since no match", async () => {
    mockListCachedPositionViews = () => [];

    const res = await server.inject({
      method: "GET",
      url: "/positions/99999999999999999999999999",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found" });
  });

  it("returns 400 for negative tokenId (-1 starts with '-', not a digit)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/-1" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

});

// ---------------------------------------------------------------------------
// GET /positions/sync/status
// NOTE: This describe block runs BEFORE POST /positions/sync so the "idle"
// shape test can observe the initial module-level syncState (status: "idle").
// The running/completed/failed tests trigger their own syncs internally.
// ---------------------------------------------------------------------------
describe("GET /positions/sync/status", () => {
  it("idle shape: all fields null, status = 'idle' (before any sync runs)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(res.statusCode).toBe(200);
    expectJson(res).toEqual({
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    });
  });

  it("running shape: startedAt is ISO string, finishedAt/error/positionCount are null", async () => {
    let resolveSyncLpData: (v: unknown) => void;
    mockSyncLpData = () =>
      new Promise((resolve) => {
        resolveSyncLpData = resolve;
      });

    await server.inject({ method: "POST", url: "/positions/sync" });

    const res = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("running");
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(body.finishedAt).toBeNull();
    expect(body.error).toBeNull();
    expect(body.positionCount).toBeNull();

    // Resolve to advance state to "completed" for the next test
    resolveSyncLpData!({ positionCount: 5 });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("completed shape: startedAt + finishedAt are ISO strings, error null, positionCount a number", async () => {
    // State is "completed" from the running test above
    const res = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.finishedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(new Date(body.finishedAt).toISOString()).toBe(body.finishedAt);
    expect(body.error).toBeNull();
    expect(typeof body.positionCount).toBe("number");
    expect(body.positionCount).toBe(5);
  });

  it("failed shape: startedAt + finishedAt are ISO strings, error is string, positionCount null", async () => {
    let rejectSyncLpData: (err: unknown) => void;
    mockSyncLpData = () =>
      new Promise((_resolve, reject) => {
        rejectSyncLpData = reject;
      });

    await server.inject({ method: "POST", url: "/positions/sync" });

    rejectSyncLpData!(new Error("RPC timeout"));
    await new Promise((r) => setTimeout(r, 20));

    const res = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.finishedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(new Date(body.finishedAt).toISOString()).toBe(body.finishedAt);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("RPC timeout");
    expect(body.positionCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /positions/sync
// ---------------------------------------------------------------------------
describe("POST /positions/sync", () => {
  it("returns 202 with message on success (fire-and-forget)", async () => {
    let resolveSyncLpData: (v: unknown) => void;
    mockSyncLpData = () =>
      new Promise((resolve) => {
        resolveSyncLpData = resolve;
      });

    const res = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ message: "Sync started" });

    // Resolve to avoid hanging promise
    resolveSyncLpData!({ positionCount: 3 });
  });

  it("returns 409 when sync is already running", async () => {
    // Keep the sync running
    let resolveSyncLpData: (v: unknown) => void;
    mockSyncLpData = () =>
      new Promise((resolve) => {
        resolveSyncLpData = resolve;
      });

    await server.inject({ method: "POST", url: "/positions/sync" });
    const res = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "Sync already in progress" });

    resolveSyncLpData!({ positionCount: 0 });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("captures RpcError(-32005) as failed state with error message", async () => {
    let rejectFn!: (e: unknown) => void;
    mockSyncLpData = () =>
      new Promise<never>((_, rej) => {
        rejectFn = rej;
      });

    await server.inject({ method: "POST", url: "/positions/sync" });
    rejectFn(new MockRpcError("RPC rate limited", -32005));
    await new Promise((r) => setTimeout(r, 20));

    const res = await server.inject({ method: "GET", url: "/positions/sync/status" });
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toContain("rate limit");
    expect(body.positionCount).toBeNull();
  });

  it("POST after failure resets state and returns 202", async () => {
    // First: cause a failure
    let rejectFn!: (e: unknown) => void;
    mockSyncLpData = () =>
      new Promise<never>((_, rej) => {
        rejectFn = rej;
      });

    const firstRes = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(firstRes.statusCode).toBe(202);
    rejectFn(new Error("simulated failure"));
    await new Promise((r) => setTimeout(r, 20));

    // Verify it's failed
    const statusRes = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(statusRes.json().status).toBe("failed");

    // Now: second POST should succeed (not 409)
    let resolveFn!: (v: any) => void;
    mockSyncLpData = () =>
      new Promise((res) => {
        resolveFn = res;
      });

    const secondRes = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(secondRes.statusCode).toBe(202);

    // Clean up: resolve the background sync
    resolveFn({ positionCount: 0 });
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ---------------------------------------------------------------------------
// POST /positions/:tokenId/sync
// ---------------------------------------------------------------------------
describe("POST /positions/:tokenId/sync", () => {
  it("returns 202 with message for valid numeric tokenId", async () => {
    mockSyncSinglePosition = async () => ({ tokenId: "42", syncedAt: new Date().toISOString() });

    const res = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ message: "Sync started" });
  });

  it("returns 400 for non-numeric tokenId (letters only)", async () => {
    const res = await server.inject({ method: "POST", url: "/positions/abc/sync" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for mixed alphanumeric tokenId", async () => {
    const res = await server.inject({ method: "POST", url: "/positions/abc123/sync" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 409 when sync is already running for a position", async () => {
    let resolveSyncSinglePosition: (v: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise((resolve) => {
        resolveSyncSinglePosition = resolve;
      });

    await server.inject({ method: "POST", url: "/positions/42/sync" });
    const res = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "Sync already in progress for position 42" });

    resolveSyncSinglePosition!({ tokenId: "42" });
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ---------------------------------------------------------------------------
// POST /positions/:tokenId/sync — invalid tokenId
// ---------------------------------------------------------------------------
describe("POST /positions/:tokenId/sync — invalid tokenId", () => {
  it("returns 400 for non-numeric tokenId (letters only)", async () => {
    const res = await server.inject({ method: "POST", url: "/positions/abc/sync" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for float tokenId (with decimal point)", async () => {
    const res = await server.inject({ method: "POST", url: "/positions/1.5/sync" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for negative tokenId (starts with minus sign)", async () => {
    const res = await server.inject({ method: "POST", url: "/positions/-1/sync" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for empty segment (empty string tokenId)", async () => {
    const res = await server.inject({ method: "POST", url: "/positions//sync" });
    // Fastify treats /positions//sync as tokenId="", which fails isNumericString
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 202 for very large but valid numeric tokenId (position may not exist, but sync attempt is made)", async () => {
    mockSyncSinglePosition = async () => ({
      tokenId: "999999999",
      syncedAt: new Date().toISOString(),
    });

    const res = await server.inject({ method: "POST", url: "/positions/999999999/sync" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ message: "Sync started" });
  });

  it("returns 202 for tokenId with leading zeros (accepted by isNumericString regex)", async () => {
    mockSyncSinglePosition = async () => ({ tokenId: "007", syncedAt: new Date().toISOString() });

    const res = await server.inject({ method: "POST", url: "/positions/007/sync" });
    // /^\d+$/ accepts leading zeros since they are digits
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ message: "Sync started" });
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/sync/status
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/sync/status", () => {
  it("returns 200 with idle status for position that has never synced", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/999/sync/status" });
    expect(res.statusCode).toBe(200);
    expectJson(res).toEqual({
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    });
  });

  it("returns 400 for non-numeric tokenId (letters only)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc/sync/status" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 400 for mixed alphanumeric tokenId", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc123/sync/status" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("running shape: startedAt is ISO string, finishedAt/error/positionCount are null", async () => {
    let resolveSyncSinglePosition: (v: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise((resolve) => {
        resolveSyncSinglePosition = resolve;
      });

    await server.inject({ method: "POST", url: "/positions/888/sync" });

    const res = await server.inject({ method: "GET", url: "/positions/888/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("running");
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(body.finishedAt).toBeNull();
    expect(body.error).toBeNull();
    expect(body.positionCount).toBeNull();

    // Resolve to advance state to "completed" for the next test
    resolveSyncSinglePosition!({ tokenId: "888" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("completed shape: startedAt + finishedAt are ISO strings, error null, positionCount is 1", async () => {
    // State is "completed" from the running test above
    const res = await server.inject({ method: "GET", url: "/positions/888/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(typeof body.startedAt).toBe("string");
    expect(typeof body.finishedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(new Date(body.finishedAt).toISOString()).toBe(body.finishedAt);
    expect(body.error).toBeNull();
    expect(body.positionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/sync/status — status contract and isolation
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/sync/status — status contract and isolation", () => {
  it("never-synced tokenId returns idle (not 404)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/777/sync/status" });
    expect(res.statusCode).toBe(200);
    expectJson(res).toEqual({
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    });
  });

  it("non-numeric tokenId returns 400", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc/sync/status" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("state isolation: A's status doesn't affect B", async () => {
    // Set up tokenId "11" to be running
    let resolveSyncSinglePosition: (v: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise((resolve) => {
        resolveSyncSinglePosition = resolve;
      });

    // Start sync for tokenId "11"
    await server.inject({ method: "POST", url: "/positions/11/sync" });

    // Verify tokenId "11" is running
    const status11 = await server.inject({ method: "GET", url: "/positions/11/sync/status" });
    expect(status11.json().status).toBe("running");

    // Check tokenId "22" (never synced) — should return idle, not "running"
    const status22 = await server.inject({ method: "GET", url: "/positions/22/sync/status" });
    expect(status22.statusCode).toBe(200);
    expectJson(status22).toEqual({
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    });

    // Clean up: resolve tokenId "11"
    resolveSyncSinglePosition!({ tokenId: "11" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("completed state shape is correct", async () => {
    // Set up tokenId "33" to complete successfully
    mockSyncSinglePosition = async () => ({ tokenId: "33", syncedAt: new Date().toISOString() });

    // Start sync for tokenId "33"
    await server.inject({ method: "POST", url: "/positions/33/sync" });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 20));

    // Check status
    const res = await server.inject({ method: "GET", url: "/positions/33/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("completed");
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(typeof body.finishedAt).toBe("string");
    expect(new Date(body.finishedAt).toISOString()).toBe(body.finishedAt);
    expect(body.positionCount).toBe(1);
    expect(body.error).toBeNull();
  });

  it("failed state is surfaced", async () => {
    // Set up tokenId "44" to fail
    let rejectFn!: (e: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise<never>((_resolve, reject) => {
        rejectFn = reject;
      });

    // Start sync for tokenId "44"
    await server.inject({ method: "POST", url: "/positions/44/sync" });

    // Reject the promise to simulate failure
    rejectFn(new Error("Simulated sync failure"));
    await new Promise((r) => setTimeout(r, 20));

    // Check status
    const res = await server.inject({ method: "GET", url: "/positions/44/sync/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(typeof body.startedAt).toBe("string");
    expect(new Date(body.startedAt).toISOString()).toBe(body.startedAt);
    expect(typeof body.finishedAt).toBe("string");
    expect(new Date(body.finishedAt).toISOString()).toBe(body.finishedAt);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("Simulated sync failure");
    expect(body.positionCount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /positions/:tokenId/sync — concurrency and state isolation
// ---------------------------------------------------------------------------
describe("POST /positions/:tokenId/sync — concurrency and state isolation", () => {
  it("second request for same tokenId while running → 409", async () => {
    // Keep the sync running with unresolved Promise
    let resolveSyncSinglePosition: (v: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise((resolve) => {
        resolveSyncSinglePosition = resolve;
      });

    // First request to tokenId "42"
    const res1 = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res1.statusCode).toBe(202);

    // Second request to same tokenId "42" while first is running
    const res2 = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ error: "Sync already in progress for position 42" });

    // Clean up: resolve to allow state to complete
    resolveSyncSinglePosition!({ tokenId: "42" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("after completion, same tokenId can sync again → 202", async () => {
    // Complete a sync for tokenId "42"
    mockSyncSinglePosition = async () => ({ tokenId: "42", syncedAt: new Date().toISOString() });

    const res1 = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res1.statusCode).toBe(202);

    // Wait for completion
    await new Promise((r) => setTimeout(r, 20));

    // Fire another POST to "42" — should succeed since state is no longer "running"
    const res2 = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res2.statusCode).toBe(202);
    expect(res2.json()).toMatchObject({ message: "Sync started" });

    // Wait for second sync to complete
    await new Promise((r) => setTimeout(r, 20));
  });

  it("two different tokenIds can sync simultaneously → both 202", async () => {
    // Keep both syncs running with unresolved Promises
    let resolveSyncSinglePosition: (v: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise((resolve) => {
        resolveSyncSinglePosition = resolve;
      });

    // Fire POST to tokenId "42" (keep running)
    const res1 = await server.inject({ method: "POST", url: "/positions/42/sync" });
    expect(res1.statusCode).toBe(202);

    // Fire POST to tokenId "99" (different tokenId, should also succeed)
    const res2 = await server.inject({ method: "POST", url: "/positions/99/sync" });
    expect(res2.statusCode).toBe(202);

    // Both should have independent states
    const status42 = await server.inject({ method: "GET", url: "/positions/42/sync/status" });
    expect(status42.json().status).toBe("running");

    const status99 = await server.inject({ method: "GET", url: "/positions/99/sync/status" });
    expect(status99.json().status).toBe("running");

    // Clean up: resolve both
    resolveSyncSinglePosition!({ tokenId: "42" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("failed state for one tokenId doesn't block another → 202", async () => {
    // Pre-configure tokenId "777" to have a "failed" status by triggering a failure
    let rejectFn!: (e: unknown) => void;
    mockSyncSinglePosition = () =>
      new Promise<never>((_resolve, reject) => {
        rejectFn = reject;
      });

    // Fire POST to tokenId "777" and make it fail
    const firstReq = await server.inject({ method: "POST", url: "/positions/777/sync" });
    expect(firstReq.statusCode).toBe(202);

    // Now reject the promise
    rejectFn(new Error("Simulated failure"));
    await new Promise((r) => setTimeout(r, 20));

    // Verify tokenId "777" is in failed state
    const status777 = await server.inject({ method: "GET", url: "/positions/777/sync/status" });
    expect(status777.json().status).toBe("failed");

    // Fire POST to tokenId "888" (different tokenId) — should succeed
    mockSyncSinglePosition = async () => ({ tokenId: "888", syncedAt: new Date().toISOString() });
    const res = await server.inject({ method: "POST", url: "/positions/888/sync" });
    expect(res.statusCode).toBe(202);

    // Wait for completion
    await new Promise((r) => setTimeout(r, 20));
  });
});
