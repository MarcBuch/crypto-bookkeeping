import { describe, it, expect, beforeAll, mock } from "bun:test";

import type { FastifyInstance } from "fastify";

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
};

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
let mockGetPositionsCacheSyncedAt: (...args: unknown[]) => unknown = () => null;
let mockSyncLpData: (...args: unknown[]) => unknown = async () => ({ synced: 0 });

// --- Mock @lp-tracker/core BEFORE importing server ---
mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: (...args: unknown[]) => mockListCachedPositionViews(...args),
  listCachedPnLViews: () => [],
  getPositionsCacheSyncedAt: (...args: unknown[]) => mockGetPositionsCacheSyncedAt(...args),
  syncLpData: (...args: unknown[]) => mockSyncLpData(...args),
  getPnLView: async () => [],
  getILView: async () => [],
  getHistoryView: async () => [],
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
}));

let server: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import("../index.js");
  server = await buildServer(fakeConfig as Parameters<typeof buildServer>[0]);
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

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(2);
    expect(body.positions[0].tokenId).toBe("123");
    expect(body.positions[1].tokenId).toBe("456");
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

  it("returns 404 for unknown nested route /positions/123/unknown", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/123/unknown" });
    expect(res.statusCode).toBe(404);
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
    expect(res.json()).toEqual({
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
      positionCount: null,
    });
  });

  it("running shape: startedAt is ISO string, finishedAt/error/positionCount are null", async () => {
    let resolveSyncLpData: (v: unknown) => void;
    mockSyncLpData = () => new Promise((resolve) => { resolveSyncLpData = resolve; });

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
    mockSyncLpData = () => new Promise((_resolve, reject) => { rejectSyncLpData = reject; });

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
    mockSyncLpData = () => new Promise((resolve) => { resolveSyncLpData = resolve; });

    const res = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ message: "Sync started" });

    // Resolve to avoid hanging promise
    resolveSyncLpData!({ positionCount: 3 });
  });

  it("returns 409 when sync is already running", async () => {
    // Keep the sync running
    let resolveSyncLpData: (v: unknown) => void;
    mockSyncLpData = () => new Promise((resolve) => { resolveSyncLpData = resolve; });

    await server.inject({ method: "POST", url: "/positions/sync" });
    const res = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "Sync already in progress" });

    resolveSyncLpData!({ positionCount: 0 });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("captures RpcError(-32005) as failed state with error message", async () => {
    let rejectFn!: (e: unknown) => void;
    mockSyncLpData = () => new Promise<never>((_, rej) => { rejectFn = rej; });

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
    mockSyncLpData = () => new Promise<never>((_, rej) => { rejectFn = rej; });

    const firstRes = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(firstRes.statusCode).toBe(202);
    rejectFn(new Error("simulated failure"));
    await new Promise((r) => setTimeout(r, 20));

    // Verify it's failed
    const statusRes = await server.inject({ method: "GET", url: "/positions/sync/status" });
    expect(statusRes.json().status).toBe("failed");

    // Now: second POST should succeed (not 409)
    let resolveFn!: (v: any) => void;
    mockSyncLpData = () => new Promise((res) => { resolveFn = res; });

    const secondRes = await server.inject({ method: "POST", url: "/positions/sync" });
    expect(secondRes.statusCode).toBe(202);

    // Clean up: resolve the background sync
    resolveFn({ positionCount: 0 });
    await new Promise((r) => setTimeout(r, 20));
  });
});
