import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

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
} satisfies Config;

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

const baseHedgeEvents = [
  {
    id: 1,
    token_id: null,
    trade_key: "trade-1",
    tax_key: "tax-1",
    coin: "HYPE",
    status: "closed",
    entry_px: 1500,
    size: 10,
    opened_at: "2024-01-01T00:00:00Z",
    closed_at: "2024-01-02T00:00:00Z",
    close_px: 1550,
    realized_pnl: 500,
    hl_fill_hash: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
  {
    id: 2,
    token_id: "123",
    trade_key: "trade-2",
    tax_key: "tax-2",
    coin: "HYPE",
    status: "open",
    entry_px: 1600,
    size: 5,
    opened_at: "2024-01-03T00:00:00Z",
    closed_at: null,
    close_px: null,
    realized_pnl: null,
    hl_fill_hash: null,
    created_at: "2024-01-03T00:00:00Z",
    updated_at: "2024-01-03T00:00:00Z",
  },
];

const fakeCachedPositions = [{ tokenId: "789", status: "closed" }];

// --- Mutable mock function references ---
let mockGetHedgeView: (config: unknown, tokenId: string) => Promise<unknown> = async () =>
  fakeHedgeView;

let mockGetHedgeEvents: (tokenId: string) => Promise<unknown> = async () => [];

let mockListCachedPositionViews: () => unknown[] = () => [];
let mockListHedgeEvents: () => unknown[] = () => [];
let mockAssignHedgeEvent: (id: number, tokenId: string | null) => unknown = () => null;
let mockAssignHedgeEventCallCount = 0;
let mockHedgeEvents = structuredClone(baseHedgeEvents);

// --- Mock @lp-tracker/core BEFORE importing server ---
await mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: () => mockListCachedPositionViews(),
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
  getHedgeEvents: (tokenId: string) => mockGetHedgeEvents(tokenId),
  listHedgeEvents: () => mockListHedgeEvents(),
  assignHedgeEvent: (id: number, tokenId: string | null) => mockAssignHedgeEvent(id, tokenId),
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
  server = await buildServer(fakeConfig);
  await server.ready();
});

beforeEach(() => {
  mockHedgeEvents = structuredClone(baseHedgeEvents);
  mockAssignHedgeEventCallCount = 0;
  mockGetHedgeView = async () => fakeHedgeView;
  mockGetHedgeEvents = async (tokenId: string) =>
    mockHedgeEvents.filter((event) => event.token_id === tokenId);
  mockListCachedPositionViews = () => fakeCachedPositions;
  mockListHedgeEvents = () => mockHedgeEvents;
  mockAssignHedgeEvent = (id: number, tokenId: string | null) => {
    mockAssignHedgeEventCallCount += 1;
    const event = mockHedgeEvents.find((candidate) => candidate.id === id);
    if (!event) {
      return null;
    }

    event.token_id = tokenId;
    return event;
  };
});

describe("GET /hedges", () => {
  it("returns assigned and unassigned hedge trades by default", async () => {
    const res = await server.inject({ method: "GET", url: "/hedges" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hedges: mockHedgeEvents });
  });

  it("filters assigned hedges", async () => {
    const res = await server.inject({ method: "GET", url: "/hedges?assigned=assigned" });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedges).toEqual([mockHedgeEvents[1]]);
  });

  it("accepts assigned=all explicitly", async () => {
    const res = await server.inject({ method: "GET", url: "/hedges?assigned=all" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hedges: mockHedgeEvents });
  });

  it("filters unassigned hedges", async () => {
    const res = await server.inject({ method: "GET", url: "/hedges?assigned=unassigned" });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedges).toEqual([mockHedgeEvents[0]]);
  });

  it("returns 400 for invalid assigned filter", async () => {
    const res = await server.inject({ method: "GET", url: "/hedges?assigned=nope" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "assigned must be one of: assigned, unassigned, all",
    });
  });
});

describe("PATCH /hedges/:id/assignment", () => {
  it("assigns a hedge to an existing cached-only position", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: "789" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({ id: 1, token_id: "789" });
  });

  it("preserves trade_key and tax_key on assignment", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: "789" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({
      id: 1,
      token_id: "789",
      trade_key: "trade-1",
      tax_key: "tax-1",
    });
  });

  it("unassigns a hedge", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/2/assignment",
      payload: { tokenId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({ id: 2, token_id: null });
  });

  it("preserves trade_key and tax_key on unassignment", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/2/assignment",
      payload: { tokenId: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({
      id: 2,
      token_id: null,
      trade_key: "trade-2",
      tax_key: "tax-2",
    });
  });

  it("reassigns a hedge from one valid LP position to another", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/2/assignment",
      payload: { tokenId: "456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({ id: 2, token_id: "456" });
  });

  it("preserves trade_key and tax_key on reassignment", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/2/assignment",
      payload: { tokenId: "456" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({
      id: 2,
      token_id: "456",
      trade_key: "trade-2",
      tax_key: "tax-2",
    });
  });

  it("accepts assignment to a closed cached position", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: "789" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hedge).toMatchObject({ id: 1, token_id: "789" });
  });

  it("returns 404 when hedge event does not exist", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/999/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Hedge event not found", id: "999" });
  });

  it("returns 400 for invalid hedge id", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/not-a-number/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "id must be a positive safe integer" });
  });

  it("returns 400 for decimal hedge id", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1.5/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "id must be a positive safe integer" });
  });

  it("returns 400 for negative hedge id", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/-1/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "id must be a positive safe integer" });
  });

  it("returns 400 for zero hedge id", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/0/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "id must be a positive safe integer" });
  });

  it("returns 400 for unsafe integer hedge id", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/9007199254740992/assignment",
      payload: { tokenId: "123" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "id must be a positive safe integer" });
  });

  it("returns 400 for null body", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      headers: { "content-type": "application/json" },
      payload: "null",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "body must be an object" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 400 for array body", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      headers: { "content-type": "application/json" },
      payload: '["123"]',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "body must be an object" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 400 for missing tokenId", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string or null" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 400 for invalid request body", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: "abc" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string or null" });
  });

  it("returns 400 for numeric tokenId provided as a number", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: 123 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string or null" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 400 for tokenId provided as an array", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: ["123"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string or null" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 400 for tokenId provided as an object", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: { value: "123" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string or null" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });

  it("returns 404 when assignment target position does not exist", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/hedges/1/assignment",
      payload: { tokenId: "999" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "999" });
    expect(mockAssignHedgeEventCallCount).toBe(0);
  });
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

    it("stays config-gated for cached-only positions with assigned hedge events", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/789/hedge" });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "789" });
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
      } satisfies Config;

      // Rebuild server with extended config
      const { buildServer } = await import("../index.js");
      const testServer = await buildServer(extendedConfig);
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

// ---------------------------------------------------------------------------
// GET /positions/:tokenId/hedge/events — Adversarial tests
// ---------------------------------------------------------------------------
describe("GET /positions/:tokenId/hedge/events", () => {
  // =========================================================================
  // Cluster A: Bad tokenId inputs
  // =========================================================================
  describe("Cluster A: Bad tokenId inputs", () => {
    it("returns 400 for non-numeric tokenId (letters only)", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/abc/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for decimal tokenId", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/1.5/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for negative tokenId", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/-1/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for mixed alphanumeric tokenId", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/abc123/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for tokenId with special characters", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/123@456/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });

    it("returns 400 for tokenId with spaces", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/123%20456/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "tokenId must be a numeric string" });
    });
  });

  // =========================================================================
  // Cluster B: Unknown position
  // =========================================================================
  describe("Cluster B: Unknown position", () => {
    it("returns 404 when tokenId not in config.positions", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/99999/hedge/events" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "99999" });
    });

    it("returns 404 with correct tokenId in error body", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/777/hedge/events" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.tokenId).toBe("777");
      expect(body.error).toBe("Position not found");
    });

    it("returns 404 for very large numeric tokenId not in config", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/positions/99999999999999999999/hedge/events",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found" });
    });

    it("returns 404 for tokenId with leading zeros not in config", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/00123/hedge/events" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: "Position not found", tokenId: "00123" });
    });
  });

  describe("Cluster B2: Position with no hedge config", () => {
    it("returns 200 for config position without hedge config", async () => {
      const res = await server.inject({ method: "GET", url: "/positions/456/hedge/events" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ events: [], tokenId: "456" });
    });

    it("calls getHedgeEvents for position without hedge config", async () => {
      let getHedgeEventsCalled = false;
      mockGetHedgeEvents = async () => {
        getHedgeEventsCalled = true;
        return [];
      };

      const res = await server.inject({ method: "GET", url: "/positions/456/hedge/events" });
      expect(res.statusCode).toBe(200);
      expect(getHedgeEventsCalled).toBe(true);
    });
  });

  // =========================================================================
  // Cluster C: Empty history (known position, no events)
  // =========================================================================
  describe("Cluster C: Empty history (known position, no events)", () => {
    it("returns 200 with empty events array for position with no hedge events", async () => {
      mockGetHedgeEvents = async () => [];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ events: [], tokenId: "123" });
    });

    it("returns 200 (not 404) for known position with empty history", async () => {
      mockGetHedgeEvents = async () => [];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      expect(res.json().events).toEqual([]);
    });

    it("returns correct tokenId in response for empty history", async () => {
      mockGetHedgeEvents = async () => [];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tokenId).toBe("123");
    });

    it("returns JSON response with correct content-type for empty history", async () => {
      mockGetHedgeEvents = async () => [];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
    });

    it("returns 200 for cached-only position token", async () => {
      mockGetHedgeEvents = async () => [];

      const res = await server.inject({ method: "GET", url: "/positions/789/hedge/events" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ events: [], tokenId: "789" });
    });
  });

  // =========================================================================
  // Cluster D: Returns events (known position, events exist)
  // =========================================================================
  describe("Cluster D: Returns events (known position, events exist)", () => {
    it("returns only hedges assigned to the requested tokenId and includes tokenId", async () => {
      mockGetHedgeEvents = async (tokenId: string) =>
        mockHedgeEvents.filter((event) => event.token_id === tokenId);

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        tokenId: "123",
        events: [
          expect.objectContaining({
            id: 2,
            token_id: "123",
            trade_key: "trade-2",
            tax_key: "tax-2",
          }),
        ],
      });
      expect(res.json().events).toHaveLength(1);
    });

    it("returns 200 with single hedge event", async () => {
      const fakeEvent = {
        id: 1,
        token_id: "123",
        coin: "HYPE",
        status: "open",
        entry_px: 1500,
        size: 10,
        opened_at: "2024-01-01T00:00:00Z",
        closed_at: null,
        close_px: null,
        realized_pnl: null,
      };

      mockGetHedgeEvents = async () => [fakeEvent];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events).toHaveLength(1);
      expect(body.events[0]).toMatchObject({
        id: 1,
        token_id: "123",
        coin: "HYPE",
        status: "open",
      });
    });

    it("returns 200 with multiple hedge events", async () => {
      const fakeEvents = [
        {
          id: 2,
          token_id: "123",
          coin: "HYPE",
          status: "closed",
          entry_px: 1600,
          size: 5,
          opened_at: "2024-01-02T00:00:00Z",
          closed_at: "2024-01-03T00:00:00Z",
          close_px: 1650,
          realized_pnl: 250,
        },
        {
          id: 1,
          token_id: "123",
          coin: "HYPE",
          status: "open",
          entry_px: 1500,
          size: 10,
          opened_at: "2024-01-01T00:00:00Z",
          closed_at: null,
          close_px: null,
          realized_pnl: null,
        },
      ];

      mockGetHedgeEvents = async () => fakeEvents;

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.events).toHaveLength(2);
      expect(body.tokenId).toBe("123");
    });

    it("returns event with all required fields", async () => {
      const fakeEvent = {
        id: 1,
        token_id: "123",
        coin: "HYPE",
        status: "open",
        entry_px: 1500,
        size: 10,
        opened_at: "2024-01-01T00:00:00Z",
        closed_at: null,
        close_px: null,
        realized_pnl: null,
      };

      mockGetHedgeEvents = async () => [fakeEvent];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const event = body.events[0];
      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("token_id");
      expect(event).toHaveProperty("coin");
      expect(event).toHaveProperty("status");
      expect(event).toHaveProperty("entry_px");
      expect(event).toHaveProperty("size");
      expect(event).toHaveProperty("opened_at");
      expect(event).toHaveProperty("closed_at");
      expect(event).toHaveProperty("close_px");
      expect(event).toHaveProperty("realized_pnl");
    });

    it("returns closed event with realized_pnl", async () => {
      const fakeEvent = {
        id: 1,
        token_id: "123",
        coin: "HYPE",
        status: "closed",
        entry_px: 1500,
        size: 10,
        opened_at: "2024-01-01T00:00:00Z",
        closed_at: "2024-01-02T00:00:00Z",
        close_px: 1550,
        realized_pnl: 500,
      };

      mockGetHedgeEvents = async () => [fakeEvent];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const event = body.events[0];
      expect(event.status).toBe("closed");
      expect(event.realized_pnl).toBe(500);
      expect(event.close_px).toBe(1550);
    });

    it("returns open event with null closed_at and close_px", async () => {
      const fakeEvent = {
        id: 1,
        token_id: "123",
        coin: "HYPE",
        status: "open",
        entry_px: 1500,
        size: 10,
        opened_at: "2024-01-01T00:00:00Z",
        closed_at: null,
        close_px: null,
        realized_pnl: null,
      };

      mockGetHedgeEvents = async () => [fakeEvent];

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const event = body.events[0];
      expect(event.status).toBe("open");
      expect(event.closed_at).toBeNull();
      expect(event.close_px).toBeNull();
      expect(event.realized_pnl).toBeNull();
    });
  });

  // =========================================================================
  // Edge cases and validation
  // =========================================================================
  describe("Edge cases and validation", () => {
    it("returns 400 before calling getHedgeEvents for invalid tokenId format", async () => {
      let getHedgeEventsCalled = false;
      mockGetHedgeEvents = async () => {
        getHedgeEventsCalled = true;
        return [];
      };

      const res = await server.inject({ method: "GET", url: "/positions/abc/hedge/events" });
      expect(res.statusCode).toBe(400);
      expect(getHedgeEventsCalled).toBe(false);
    });

    it("returns 404 before calling getHedgeEvents for unknown tokenId", async () => {
      let getHedgeEventsCalled = false;
      mockGetHedgeEvents = async () => {
        getHedgeEventsCalled = true;
        return [];
      };

      const res = await server.inject({ method: "GET", url: "/positions/999/hedge/events" });
      expect(res.statusCode).toBe(404);
      expect(getHedgeEventsCalled).toBe(false);
    });

    it("returns 500 when getHedgeEvents throws error", async () => {
      mockGetHedgeEvents = async () => {
        throw new Error("Database connection failed");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toContain("Database connection failed");
      expect(body.tokenId).toBe("123");
    });

    it("returns 500 when getHedgeEvents throws non-Error object", async () => {
      mockGetHedgeEvents = async () => {
        throw "string error";
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(500);
      const body = res.json();
      expect(body.error).toBe("string error");
      expect(body.tokenId).toBe("123");
    });

    it("returns JSON response with correct content-type for error", async () => {
      mockGetHedgeEvents = async () => {
        throw new Error("API error");
      };

      const res = await server.inject({ method: "GET", url: "/positions/123/hedge/events" });
      expect(res.statusCode).toBe(500);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(typeof res.json()).toBe("object");
    });

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
      } satisfies Config;

      // Rebuild server with extended config
      const { buildServer } = await import("../index.js");
      const testServer = await buildServer(extendedConfig);
      await testServer.ready();

      mockGetHedgeEvents = async () => [];

      const res = await testServer.inject({
        method: "GET",
        url: "/positions/999999999999999999/hedge/events",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tokenId).toBe("999999999999999999");
    });
  });
});
