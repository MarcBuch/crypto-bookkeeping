import { describe, it, expect, beforeAll, mock } from "bun:test";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

// --- Minimal fake config ---
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
} satisfies Config;

// --- Error classes used in mocks ---
class MockNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "NotFoundError";
  }
}

class MockRpcError extends Error {
  code?: number;
  constructor(msg: string, code?: number) {
    super(msg);
    this.name = "RpcError";
    this.code = code;
  }
}

class MockValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ValidationError";
  }
}

// --- Minimal fake HistoryView objects ---
const fakeHistoryEntry = {
  tokenId: "123",
  pair: "WETH/USDC",
  timestamp: "2024-01-01T00:00:00.000Z",
  currentPrice: 2000,
  divergenceLossPercent: -0.005,
  fees0: 0.01,
  fees1: 10,
  feesValue: 30,
  netPnl: 100,
  valueLp: 3700,
  valueHold: 3800,
};

// --- Mutable mock function reference ---
let mockGetHistoryView: (...args: unknown[]) => unknown = async () => [fakeHistoryEntry];
// Track last call arguments for assertion
let lastHistoryCallArgs: unknown[] = [];

// --- Mock @lp-tracker/core BEFORE importing server ---
await mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: () => [],
  listCachedPnLViews: () => [],
  getPositionsCacheSyncedAt: () => null,
  syncLpData: async () => ({ synced: 0 }),
  syncSinglePosition: async () => ({ tokenId: "42", syncedAt: new Date().toISOString() }),
  getPnLView: async () => [],
  getILView: async () => [],
  getHistoryView: (...args: unknown[]) => {
    lastHistoryCallArgs = args;
    return mockGetHistoryView(...args);
  },
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
  updateTaxTransaction: () => null,
  enrichTaxTransactionsEurValues: async () => ({ enriched: 0, skipped: 0 }),
  NotFoundError: MockNotFoundError,
  RpcError: MockRpcError,
  ValidationError: MockValidationError,
}));

let server: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import("../index.js");
  server = await buildServer(fakeConfig);
  await server.ready();
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/history
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/history", () => {
  it("returns 400 for non-numeric tokenId", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc/history" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 404 when service throws NotFoundError", async () => {
    mockGetHistoryView = async () => {
      throw new MockNotFoundError("No stored data for position #123.");
    };

    const res = await server.inject({ method: "GET", url: "/positions/123/history" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "123" });
  });

  it("returns 200 with history data when service succeeds", async () => {
    mockGetHistoryView = async () => [fakeHistoryEntry];

    const res = await server.inject({ method: "GET", url: "/positions/123/history" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokenId).toBe("123");
    expect(body.history).toHaveLength(1);
    expect(body.history[0].pair).toBe("WETH/USDC");
  });

  it("passes limit=5 to service when ?limit=5 is provided", async () => {
    mockGetHistoryView = async () => [fakeHistoryEntry];
    lastHistoryCallArgs = [];

    const res = await server.inject({ method: "GET", url: "/positions/123/history?limit=5" });
    expect(res.statusCode).toBe(200);
    // Second arg to getHistoryView is the parsed limit
    expect(lastHistoryCallArgs[1]).toBe(5);
  });

  it("returns 400 for non-numeric limit query param", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/123/history?limit=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("limit must be a positive integer"),
    });
  });

  it("returns 400 when limit=0 (must be >= 1)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/123/history?limit=0" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("limit must be a positive integer"),
    });
  });

  it("returns 400 when limit=-5 (negative not allowed)", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/123/history?limit=-5" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringContaining("limit must be a positive integer"),
    });
  });

  it("clamps limit=999 to 200 and passes 200 to service", async () => {
    mockGetHistoryView = async () => [fakeHistoryEntry];
    lastHistoryCallArgs = [];

    const res = await server.inject({ method: "GET", url: "/positions/123/history?limit=999" });
    expect(res.statusCode).toBe(200);
    // The route clamps to max=200
    expect(lastHistoryCallArgs[1]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/snapshots
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/snapshots", () => {
  it("returns 200 with snapshots data", async () => {
    mockGetHistoryView = async () => [fakeHistoryEntry];

    const res = await server.inject({ method: "GET", url: "/positions/123/snapshots" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokenId).toBe("123");
    expect(body.snapshots).toHaveLength(1);
  });

  it("returns 404 when service throws NotFoundError", async () => {
    mockGetHistoryView = async () => {
      throw new MockNotFoundError("No stored data for position #123.");
    };

    const res = await server.inject({ method: "GET", url: "/positions/123/snapshots" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "123" });
  });
});
