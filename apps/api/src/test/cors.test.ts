import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

const fakeConfig: Config = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
};

mock.module("@lp-tracker/core", () => ({
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
  createManualTaxTransaction: () => null,
  enrichTaxTransactionsEurValues: async () => ({ enriched: 0, skipped: 0 }),
  NotFoundError: class NotFoundError extends Error {},
  RpcError: class RpcError extends Error {
    code?: number;
    constructor(msg: string, code?: number) {
      super(msg);
      this.code = code;
    }
  },
  ValidationError: class ValidationError extends Error {},
}));

let buildServer: (config?: Config) => Promise<FastifyInstance>;

beforeAll(async () => {
  ({ buildServer } = await import("../index.js"));
});

afterEach(() => {
  delete process.env.CORS_ORIGIN;
  delete process.env.NODE_ENV;
});

async function withServer(run: (server: FastifyInstance) => Promise<void>): Promise<void> {
  const server = await buildServer(fakeConfig);
  try {
    await server.ready();
    await run(server);
  } finally {
    await server.close();
  }
}

describe("CORS", () => {
  it("allows Vite dev origin by default outside production", async () => {
    await withServer(async (server) => {
      const res = await server.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:5173" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });
  });

  it("handles preflight requests for configured methods and headers", async () => {
    process.env.CORS_ORIGIN = "http://localhost:5173";

    await withServer(async (server) => {
      const res = await server.inject({
        method: "OPTIONS",
        url: "/positions",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.headers["access-control-allow-methods"]).toContain("GET");
      expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
      expect(res.headers["access-control-allow-headers"]).toBe("content-type");
    });
  });

  it("allows tax transaction PATCH preflight requests", async () => {
    process.env.CORS_ORIGIN = "http://localhost:5173";

    await withServer(async (server) => {
      const res = await server.inject({
        method: "OPTIONS",
        url: "/tax/transactions/hyperscan%3Atxlist%3A0xhash%3Aexternal",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "content-type",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
      expect(res.headers["access-control-allow-headers"]).toBe("content-type");
    });
  });

  it("does not echo unknown origins when CORS_ORIGIN is configured", async () => {
    process.env.CORS_ORIGIN = "http://localhost:5173";

    await withServer(async (server) => {
      const res = await server.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://evil.example" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.headers["access-control-allow-origin"]).not.toBe("http://evil.example");
    });
  });

  it("does not allow browser origins by default in production", async () => {
    process.env.NODE_ENV = "production";

    await withServer(async (server) => {
      const res = await server.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:5173" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });
  });

  it("keeps JSON error responses intact with CORS enabled", async () => {
    process.env.CORS_ORIGIN = "http://localhost:5173";

    await withServer(async (server) => {
      const res = await server.inject({
        method: "GET",
        url: "/positions/not-a-token/pnl",
        headers: { origin: "http://localhost:5173" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.json() as unknown).toEqual({
        error: "tokenId must be a numeric string",
      });
    });
  });
});
