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

// --- Mutable mock function references ---
let mockGetPositionsView: (...args: unknown[]) => unknown = async () => [];

// --- Mock @lp-tracker/core BEFORE importing server ---
mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: (...args: unknown[]) => mockGetPositionsView(...args),
  getPnLView: async () => [],
  getILView: async () => [],
  getHistoryView: async () => [],
  listTaxTransactions: () => [],
  syncTaxTransactions: async () => ({}),
  updateTaxTransaction: () => null,
  NotFoundError: class NotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "NotFoundError";
    }
  },
  RpcError: class RpcError extends Error {
    code?: number;
    constructor(msg: string, code?: number) {
      super(msg);
      this.name = "RpcError";
      this.code = code;
    }
  },
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
    mockGetPositionsView = async () => [];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ positions: [] });
  });

  it("returns 200 with 2 positions", async () => {
    mockGetPositionsView = async () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(2);
    expect(body.positions[0].tokenId).toBe("123");
    expect(body.positions[1].tokenId).toBe("456");
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
    mockGetPositionsView = async () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions/999" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
  });

  it("returns 200 with matching position", async () => {
    mockGetPositionsView = async () => [fakePosition, fakePosition2];

    const res = await server.inject({ method: "GET", url: "/positions/123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ position: { tokenId: "123" } });
  });

  it("accepts very large numeric string tokenId → 404 since no match", async () => {
    mockGetPositionsView = async () => [];

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
