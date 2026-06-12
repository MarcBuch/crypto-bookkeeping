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
  positions: {
    "123": {
      openTx: "0x123abc",
      hedge: {
        coin: "HYPE",
      },
    },
    "456": {
      openTx: "0x456def",
      // No hedge config for this position
    },
  },
};

// --- Fake HedgeView response ---
const fakeHedgeView = {
  tokenId: "123",
  coin: "HYPE",
  szi: "-30.1",
  entryPx: 1500,
  markPx: 1600,
  unrealizedPnl: 3000,
  fundingEarned: 150,
  liquidationPx: 1200,
  leverage: { type: "cross", value: 1 },
};

// --- Mutable mock function reference ---
let mockGetHedgeView: (config: unknown, tokenId: string) => Promise<unknown> = async () =>
  fakeHedgeView;

// --- Mock @lp-tracker/core BEFORE importing server ---
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
  listTaxTransactions: () => [],
  syncTaxTransactions: async () => ({}),
  createManualTaxTransaction: () => null,
  updateTaxTransaction: () => null,
  enrichTaxTransactionsEurValues: async () => ({ enriched: 0, skipped: 0 }),
  getHedgeView: (config: unknown, tokenId: string) => mockGetHedgeView(config, tokenId),
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
// GET /positions/:tokenId/hedge — Adversarial tests
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/hedge", () => {
  // =========================================================================
  // Non-numeric tokenId validation
  // =========================================================================
  describe("Non-numeric tokenId validation", () => {
    it("returns 400 for non-numeric tokenId (letters only)", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/abc/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for mixed alphanumeric tokenId", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/abc123/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for negative tokenId (starts with minus sign)", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/-1/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for float tokenId (with decimal point)", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/1.5/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for empty tokenId", async () => {
      const res = await server.inject({ method: "GET", url: "/positions//hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for tokenId with special characters", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/123@456/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for tokenId with spaces", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/123%20456/hedge" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });
  });

  // =========================================================================
  // Unknown tokenId (not in config.positions)
  // =========================================================================
  describe("Unknown tokenId", () => {
    it("returns 404 when tokenId not in config.positions", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/999/hedge" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
    });

    it("returns 404 with correct tokenId in error body", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/777/hedge" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.tokenId).toBe("777");
      expect(body.error).toBe("Position not found");
    });

    it("returns 404 for very large numeric tokenId not in config", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/positions/99999999999999999999/hedge",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found" });
    });

    it("returns 404 for tokenId with leading zeros not in config", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/00123/hedge" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "00123" });
    });
  });

  // =========================================================================
  // No hedge config for position
  // =========================================================================
  describe("No hedge config for position", () => {
    it("returns 404 when position exists but has no hedge config", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/456/hedge" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: "No hedge configured for this position",
        tokenId: "456",
      });
    });

    it("returns 404 with correct tokenId in error body for missing hedge", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/456/hedge" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.tokenId).toBe("456");
      expect(body.error).toBe("No hedge configured for this position");
    });

    it("distinguishes between 'position not found' and 'no hedge config' errors", async () => {
      // Position 999 doesn't exist
      const res1 = await server.inject({ method: "GET", url: "/positions/999/hedge" });
      expect(res1.statusCode).toBe(404);
      expect(res1.json().error).toBe("Position not found");

      // Position 456 exists but has no hedge
      const res2 = await server.inject({ method: "GET", url: "/positions/456/hedge" });
      expect(res2.statusCode).toBe(404);
      expect(res2.json().error).toBe("No hedge configured for this position");
    });
  });

  // =========================================================================
  // Hyperliquid API unreachable / errors
  // =========================================================================
  describe("Hyperliquid API unreachable / errors", () => {
    it("returns 502 when getHedgeView throws network error", async () => {
      mockGetHedgeView = async () => {
        throw new Error("network error: ECONNREFUSED");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toContain("network error");
      expect(body.tokenId).toBe("123");
    });

    it("returns 502 when getHedgeView throws timeout error", async () => {
      mockGetHedgeView = async () => {
        throw new Error("Request timeout after 30000ms");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toContain("timeout");
      expect(body.tokenId).toBe("123");
    });

    it("returns 502 with error message in body when API fails", async () => {
      mockGetHedgeView = async () => {
        throw new Error("Hyperliquid API returned 500");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    });

    it("returns 502 when getHedgeView throws generic Error", async () => {
      mockGetHedgeView = async () => {
        throw new Error("Something went wrong");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: "Something went wrong", tokenId: "123" });
    });

    it("returns 502 when getHedgeView throws non-Error object", async () => {
      mockGetHedgeView = async () => {
        // eslint-disable-next-line no-throw-literal
        throw "string error";
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toBe("string error");
      expect(body.tokenId).toBe("123");
    });

    it("returns 502 when getHedgeView throws null", async () => {
      mockGetHedgeView = async () => {
        // eslint-disable-next-line no-throw-literal
        throw null;
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error).toBe("null");
      expect(body.tokenId).toBe("123");
    });

    it("returns 502 when getHedgeView throws object without message", async () => {
      mockGetHedgeView = async () => {
        // eslint-disable-next-line no-throw-literal
        throw { code: "ECONNREFUSED" };
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(typeof body.error).toBe("string");
      expect(body.tokenId).toBe("123");
    });
  });

  // =========================================================================
  // Healthy response path
  // =========================================================================
  describe("Healthy response path", () => {
    it("returns 200 with valid HedgeView when all conditions met", async () => {
      mockGetHedgeView = async () => fakeHedgeView;

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        tokenId: "123",
        coin: "HYPE",
        szi: "-30.1",
        entryPx: 1500,
        markPx: 1600,
        unrealizedPnl: 3000,
        fundingEarned: 150,
        liquidationPx: 1200,
      });
    });

    it("returns 200 with correct HedgeView shape", async () => {
      mockGetHedgeView = async () => fakeHedgeView;

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("tokenId");
      expect(body).toHaveProperty("coin");
      expect(body).toHaveProperty("szi");
      expect(body).toHaveProperty("entryPx");
      expect(body).toHaveProperty("markPx");
      expect(body).toHaveProperty("unrealizedPnl");
      expect(body).toHaveProperty("fundingEarned");
      expect(body).toHaveProperty("liquidationPx");
      expect(body).toHaveProperty("leverage");
    });

    it("returns 200 with leverage object in response", async () => {
      mockGetHedgeView = async () => fakeHedgeView;

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.leverage).toMatchObject({ type: "cross", value: 1 });
    });

    it("returns 200 with null liquidationPx when applicable", async () => {
      mockGetHedgeView = async () => ({
        ...fakeHedgeView,
        liquidationPx: null,
      });

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.liquidationPx).toBeNull();
    });

    it("returns 200 with negative szi (short position)", async () => {
      mockGetHedgeView = async () => ({
        ...fakeHedgeView,
        szi: "-50.5",
      });

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.szi).toBe("-50.5");
    });

    it("returns 200 with zero unrealizedPnl", async () => {
      mockGetHedgeView = async () => ({
        ...fakeHedgeView,
        unrealizedPnl: 0,
      });

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.unrealizedPnl).toBe(0);
    });

    it("returns 200 with negative unrealizedPnl (loss)", async () => {
      mockGetHedgeView = async () => ({
        ...fakeHedgeView,
        unrealizedPnl: -1500,
      });

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.unrealizedPnl).toBe(-1500);
    });
  });

  // =========================================================================
  // Edge cases and boundary conditions
  // =========================================================================
  describe("Edge cases and boundary conditions", () => {
    it("accepts very large numeric tokenId that exists in config", async () => {
      // Extend config to include a large tokenId
      const extendedConfig = {
        ...fakeConfig,
        positions: {
          ...fakeConfig.positions,
          "999999999999999999": {
            openTx: "0x999abc",
            hedge: { coin: "HYPE" },
          },
        },
      };

      // Rebuild server with extended config
      const { buildServer } = await import("../index.js");
      const testServer = await buildServer(extendedConfig as Parameters<typeof buildServer>[0]);
      await testServer.ready();

      mockGetHedgeView = async () => ({
        ...fakeHedgeView,
        tokenId: "999999999999999999",
      });

      const res = await testServer.inject({
        method: "GET",
        url: "/positions/999999999999999999/hedge",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tokenId).toBe("999999999999999999");
    });

    it("returns 404 before calling getHedgeView for unknown tokenId", async () => {
      let getHedgeViewCalled = false;
      mockGetHedgeView = async () => {
        getHedgeViewCalled = true;
        return fakeHedgeView;
      };

      const res = await server.inject({ method: "GET", url: "/positions/999/hedge" });
      expect(res.statusCode).toBe(404);
      expect(getHedgeViewCalled).toBe(false);
    });

    it("returns 404 before calling getHedgeView for missing hedge config", async () => {
      let getHedgeViewCalled = false;
      mockGetHedgeView = async () => {
        getHedgeViewCalled = true;
        return fakeHedgeView;
      };

      const res = await server.inject({ method: "GET", url: "/positions/456/hedge" });
      expect(res.statusCode).toBe(404);
      expect(getHedgeViewCalled).toBe(false);
    });

    it("returns 400 before calling getHedgeView for invalid tokenId format", async () => {
      let getHedgeViewCalled = false;
      mockGetHedgeView = async () => {
        getHedgeViewCalled = true;
        return fakeHedgeView;
      };

      const res = await server.inject({ method: "GET", url: "/positions/abc/hedge" });
      expect(res.statusCode).toBe(400);
      expect(getHedgeViewCalled).toBe(false);
    });
  });

  // =========================================================================
  // Response content-type and structure
  // =========================================================================
  describe("Response content-type and structure", () => {
    it("returns JSON response with correct content-type", async () => {
      mockGetHedgeView = async () => fakeHedgeView;

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("returns JSON error response for 404", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/999/hedge" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(typeof res.json()).toBe("object");
    });

    it("returns JSON error response for 502", async () => {
      mockGetHedgeView = async () => {
        throw new Error("API error");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge" });
      expect(res.statusCode).toBe(502);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(typeof res.json()).toBe("object");
    });
  });
});
