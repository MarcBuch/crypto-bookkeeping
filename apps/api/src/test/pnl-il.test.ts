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

// --- Minimal fake PnLView object ---
const fakePnLView = {
  tokenId: "123",
  pair: "WETH/USDC",
  token0Symbol: "WETH",
  token1Symbol: "USDC",
  status: "active" as const,
  entryPrice: 1800,
  exitPrice: 2000,
  priceChangePercent: 0.111,
  entryAmount0: 1.0,
  entryAmount1: 1800,
  exitAmount0: 0.9,
  exitAmount1: 1900,
  feesCollected0: 0.01,
  feesCollected1: 10,
  feesCollected0Usd: 20,
  feesCollected1Usd: 10,
  feesValueInToken1: 30,
  feesValueUsd: 30,
  token0UsdPrice: 2000,
  token1UsdPrice: 1,
  usdPriceSource: "coingecko" as const,
  entryValueInToken1: 3600,
  exitValueInToken1: 3700,
  holdValueInToken1: 3800,
  absolutePnlInToken1: 100,
  absolutePnlPercent: 0.027,
  divergenceLossPercent: -0.005,
  opportunityCostInToken1: 200,
  netVsHodlPercent: -0.025,
  priceLower: 1600,
  priceUpper: 2400,
};

const nullableUsdFields = {
  feesCollected0Usd: null,
  feesCollected1Usd: null,
  feesValueUsd: null,
  token0UsdPrice: null,
  token1UsdPrice: null,
  usdPriceSource: null,
};

const fakePnLViewWithNullUsd = {
  ...fakePnLView,
  ...nullableUsdFields,
};

// --- Minimal fake ILView object ---
const fakeILView = {
  tokenId: "123",
  pair: "WETH/USDC",
  token0Symbol: "WETH",
  token1Symbol: "USDC",
  status: "active" as const,
  entryPrice: 1800,
  currentPrice: 2000,
  priceLower: 1600,
  priceUpper: 2400,
  divergenceLossPercent: -0.005,
  valueLpInToken1: 3700,
  valueHoldInToken1: 3800,
  fees0: 0.01,
  fees1: 10,
  feesValueInToken1: 30,
  netVsHodlPercent: -0.002,
  netVsHodlInToken1: -10,
};

// --- Mutable mock function references ---
let mockListCachedPnLViews: (...args: unknown[]) => unknown = () => [];
let mockGetPositionsCacheSyncedAt: (...args: unknown[]) => unknown = () => null;
let mockGetILView: (...args: unknown[]) => unknown = async () => [];

// --- Mock @lp-tracker/core BEFORE importing server ---
await mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: () => [],
  listCachedPnLViews: (...args: unknown[]) => mockListCachedPnLViews(...args),
  getPositionsCacheSyncedAt: (...args: unknown[]) => mockGetPositionsCacheSyncedAt(...args),
  syncLpData: async () => ({ synced: 0 }),
  syncSinglePosition: async () => ({ tokenId: "42", syncedAt: new Date().toISOString() }),
  getPnLView: async () => [],
  getILView: (...args: unknown[]) => mockGetILView(...args),
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
// GET /pnl
// ---------------------------------------------------------------------------
describe("GET /pnl", () => {
  it("returns 200 with positions array", async () => {
    mockListCachedPnLViews = () => [fakePnLView];

    const res = await server.inject({ method: "GET", url: "/pnl" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0].tokenId).toBe("123");
    expect(body.positions[0]).toMatchObject({
      feesCollected0Usd: 20,
      feesCollected1Usd: 10,
      feesValueUsd: 30,
      token0UsdPrice: 2000,
      token1UsdPrice: 1,
      usdPriceSource: "coingecko",
    });
  });

  it("preserves nullable USD fields as null", async () => {
    mockListCachedPnLViews = () => [fakePnLViewWithNullUsd];

    const res = await server.inject({ method: "GET", url: "/pnl" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0]).toMatchObject(nullableUsdFields);
  });

  it("includes syncedAt field in response", async () => {
    mockListCachedPnLViews = () => [];

    const res = await server.inject({ method: "GET", url: "/pnl" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("syncedAt");
  });

  it("returns 200 with empty positions and null syncedAt when cache is empty", async () => {
    mockListCachedPnLViews = () => [];
    mockGetPositionsCacheSyncedAt = () => null;

    const res = await server.inject({ method: "GET", url: "/pnl" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toEqual([]);
    expect(body.syncedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/pnl
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/pnl", () => {
  it("returns 400 for non-numeric tokenId", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc/pnl" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 404 when tokenId is not in cache", async () => {
    mockListCachedPnLViews = () => [];

    const res = await server.inject({ method: "GET", url: "/positions/999/pnl" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
  });

  it("returns 404 when cache has other positions but not the requested one", async () => {
    mockListCachedPnLViews = () => [fakePnLView]; // has tokenId "123", not "456"

    const res = await server.inject({ method: "GET", url: "/positions/456/pnl" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "456" });
  });

  it("returns 200 with PnL result when found in cache", async () => {
    mockListCachedPnLViews = () => [fakePnLView];

    const res = await server.inject({ method: "GET", url: "/positions/123/pnl" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      position: {
        tokenId: "123",
        pair: "WETH/USDC",
        feesCollected0Usd: 20,
        feesCollected1Usd: 10,
        feesValueUsd: 30,
        token0UsdPrice: 2000,
        token1UsdPrice: 1,
        usdPriceSource: "coingecko",
      },
    });
  });

  it("preserves nullable USD fields as null without returning a route-level 500", async () => {
    mockListCachedPnLViews = () => [fakePnLViewWithNullUsd];

    const res = await server.inject({ method: "GET", url: "/positions/123/pnl" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      position: {
        tokenId: "123",
        ...nullableUsdFields,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// GET /il
// ---------------------------------------------------------------------------
describe("GET /il", () => {
  it("returns 200 with positions array", async () => {
    mockGetILView = async () => [fakeILView];

    const res = await server.inject({ method: "GET", url: "/il" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(1);
    expect(body.positions[0].tokenId).toBe("123");
  });

  it("returns 503 when service throws RpcError with code -32005", async () => {
    mockGetILView = async () => {
      throw new MockRpcError("Rate limited", -32005);
    };

    const res = await server.inject({ method: "GET", url: "/il" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "RPC rate limited, try again later" });
  });

  it("returns 500 when service throws a generic error", async () => {
    mockGetILView = async () => {
      throw new Error("Unexpected failure");
    };

    const res = await server.inject({ method: "GET", url: "/il" });
    expect(res.statusCode).toBe(500);
  });

  it("returns 200 with empty positions array when service returns no rows", async () => {
    mockGetILView = async () => [];

    const res = await server.inject({ method: "GET", url: "/il" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ positions: [] });
  });
});

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/il
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/il", () => {
  it("returns 400 for non-numeric tokenId", async () => {
    const res = await server.inject({ method: "GET", url: "/positions/abc/il" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
  });

  it("returns 404 when service throws NotFoundError", async () => {
    mockGetILView = async () => {
      throw new MockNotFoundError("Position #999 not found.");
    };

    const res = await server.inject({ method: "GET", url: "/positions/999/il" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
  });

  it("returns 503 when service throws RpcError with code -32005", async () => {
    mockGetILView = async () => {
      throw new MockRpcError("Rate limited", -32005);
    };

    const res = await server.inject({ method: "GET", url: "/positions/123/il" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "RPC rate limited, try again later" });
  });

  it("returns 500 when service throws generic Error", async () => {
    mockGetILView = async () => {
      throw new Error("Unexpected failure");
    };

    const res = await server.inject({ method: "GET", url: "/positions/123/il" });
    expect(res.statusCode).toBe(500);
  });

  it("returns 200 with IL result when service succeeds", async () => {
    mockGetILView = async () => [fakeILView];

    const res = await server.inject({ method: "GET", url: "/positions/123/il" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ position: { tokenId: "123", pair: "WETH/USDC" } });
  });
});
