/**
 * Adversarial tests for getHedgeView() closed position path:
 *  - Cluster A: No snapshots (closed, no fills)
 *  - Cluster B: HL fills API down after detecting szi=0
 *  - Cluster C: Closed shape contract (with closing fill)
 *  - Cluster D: Active position still returns status: "active"
 */

import { Database } from "bun:sqlite";
import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

import { initSchema } from "../db/schema.js";

// Mock getDb before importing store functions
let testDb: Database;

await mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

import type { Config } from "../config.js";
import { insertHedgeSnapshot } from "../db/store.js";
import { getHedgeView } from "../services/hedge.js";

const originalFetch = globalThis.fetch;

// Helper to create a minimal config
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpc: "http://test-rpc",
    chainId: 999,
    wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
    contracts: {
      factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
    },
    ...overrides,
  };
}

// Helper to build a clearinghouseState response with given szi
function buildClearinghouseState(szi: string) {
  return {
    assetPositions: [
      {
        position: {
          coin: "HYPE",
          szi,
          entryPx: "61.5",
          positionValue: szi === "0" ? "0" : "1845",
          unrealizedPnl: szi === "0" ? "0" : "15.0",
          cumFunding: { sinceOpen: "0.5" },
          leverage: { type: "cross", value: 1 },
          liquidationPx: szi === "0" ? "0" : "50.0",
          markPx: "62.0",
        },
        type: "perp",
      },
    ],
  };
}

beforeEach(() => {
  // Create a fresh in-memory database for each test
  testDb = new Database(":memory:");
  initSchema(testDb);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("Expected promise to reject");
}

describe("getHedgeView() — closed position path", () => {
  // =========================================================================
  // Cluster A: No snapshots (closed, no fills)
  // =========================================================================
  describe("Cluster A: No snapshots (closed, no fills)", () => {
    it("szi=0, no hedge_snapshots in DB, userFillsByTime returns [] → returns HedgeView with status: closed, realizedPnl: null, closedAt: null", async () => {
      const config = makeConfig({
        positions: {
          "456": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      let callCount = 0;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        callCount++;
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "456");
      expect(result).toBeDefined();
      expect(result.status).toBe("closed");
      expect(result.szi).toBe("0");
      expect(result.unrealizedPnl).toBe(0);
      expect(result.realizedPnl).toBeNull();
      expect(result.closedAt).toBeNull();
      expect(result.closeReason).toBeNull();
      // Note: callCount is 1 because resolveHedgeClose returns null early (no open event from snapshots)
      expect(callCount).toBe(1); // only clearinghouseState
    });

    it("szi=0, no snapshots, no fills → must NOT throw", async () => {
      const config = makeConfig({
        positions: {
          "456": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      // Should not throw
      const result = await getHedgeView(config, "456");
      expect(result).toBeDefined();
      expect(result.status).toBe("closed");
    });
  });

  // =========================================================================
  // Cluster B: HL fills API down after detecting szi=0
  // =========================================================================
  describe("Cluster B: HL fills API down after detecting szi=0", () => {
    it("szi=0, clearinghouseState returns 0 position, userFillsByTime fetch throws Network error → propagates error", async () => {
      const config = makeConfig({
        positions: {
          "789": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot so resolveHedgeOpen can bootstrap
      insertHedgeSnapshot({
        token_id: "789",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 15.0,
        funding_earned: 0.5,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          throw new Error("Network error");
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const error = await captureError(getHedgeView(config, "789"));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Network error");
    });

    it("szi=0, userFillsByTime returns HTTP 502 → propagates error (not swallowed)", async () => {
      const config = makeConfig({
        positions: {
          "999": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot so resolveHedgeOpen can bootstrap
      insertHedgeSnapshot({
        token_id: "999",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 15.0,
        funding_earned: 0.5,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: false,
            status: 502,
            statusText: "Bad Gateway",
            json: async () => ({}),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const promise = getHedgeView(config, "999");
      const error = await captureError(promise);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("502");
    });
  });

  // =========================================================================
  // Cluster C: Closed shape contract (with closing fill)
  // =========================================================================
  describe("Cluster C: Closed shape contract (with closing fill)", () => {
    it("szi=0, with closing fill {closedPnl: -63, px: 61.58, tid: 999, dir: Close Short} → returns complete HedgeView with all fields", async () => {
      const config = makeConfig({
        positions: {
          "111": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot so resolveHedgeOpen can bootstrap
      insertHedgeSnapshot({
        token_id: "111",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 15.0,
        funding_earned: 0.5,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                coin: "HYPE",
                px: "61.58",
                sz: "30.1",
                side: "A",
                time: Date.now(),
                closedPnl: "-63",
                oid: 12345,
                tid: 999,
                dir: "Close Short",
              },
            ],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "111");

      // Verify all fields
      expect(result.status).toBe("closed");
      expect(result.szi).toBe("0");
      expect(result.unrealizedPnl).toBe(0);
      expect(result.liquidationPx).toBeNull();
      expect(result.realizedPnl).toBe(-63);
      expect(result.closedAt).toBeDefined();
      expect(result.closedAt).not.toBeNull();
      // Verify closedAt is a valid ISO timestamp
      expect(typeof result.closedAt).toBe("string");
      expect(new Date(result.closedAt!).getTime()).toBeGreaterThan(0);
      expect(result.closeReason).toBe("manual_close");
      expect(result.fundingEarned).toBe(0.5);
      expect(result.entryPx).toBe(61.5);
      expect(result.markPx).toBe(62.0);
      expect(result.leverage).toEqual({ type: "cross", value: 1 });
      expect(result.tokenId).toBe("111");
      expect(result.coin).toBe("HYPE");
    });

    it("szi=0, with multiple closing fills → sums closedPnl correctly", async () => {
      const config = makeConfig({
        positions: {
          "222": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot
      insertHedgeSnapshot({
        token_id: "222",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 15.0,
        funding_earned: 1.0,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                coin: "HYPE",
                px: "61.58",
                sz: "15.0",
                side: "A",
                time: Date.now(),
                closedPnl: "-30",
                oid: 12345,
                tid: 1001,
                dir: "Close Short",
              },
              {
                coin: "HYPE",
                px: "61.60",
                sz: "15.1",
                side: "A",
                time: Date.now() + 1000,
                closedPnl: "-33",
                oid: 12346,
                tid: 1002,
                dir: "Close Short",
              },
            ],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "222");

      expect(result.status).toBe("closed");
      expect(result.realizedPnl).toBe(-63); // -30 + -33
      expect(result.fundingEarned).toBe(1.0);
    });

    it("szi=0, closing fill with zero closedPnl → realizedPnl is 0", async () => {
      const config = makeConfig({
        positions: {
          "333": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot
      insertHedgeSnapshot({
        token_id: "333",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 0,
        funding_earned: 0,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                coin: "HYPE",
                px: "61.5",
                sz: "30.1",
                side: "A",
                time: Date.now(),
                closedPnl: "0",
                oid: 12345,
                tid: 2001,
                dir: "Close Short",
              },
            ],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "333");

      expect(result.status).toBe("closed");
      expect(result.realizedPnl).toBe(0);
    });

    it("szi=0, closing fill with positive closedPnl (profit) → realizedPnl is positive", async () => {
      const config = makeConfig({
        positions: {
          "444": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      // Insert a hedge snapshot
      insertHedgeSnapshot({
        token_id: "444",
        coin: "HYPE",
        szi: "-30.1",
        entry_px: 61.5,
        mark_px: 62.0,
        unrealized_pnl: 0,
        funding_earned: 0,
        liquidation_px: 50.0,
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("0"),
          } as unknown as Response;
        }
        if (body.type === "userFillsByTime") {
          return {
            ok: true,
            status: 200,
            json: async () => [
              {
                coin: "HYPE",
                px: "60.0",
                sz: "30.1",
                side: "A",
                time: Date.now(),
                closedPnl: "45.15",
                oid: 12345,
                tid: 3001,
                dir: "Close Short",
              },
            ],
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "444");

      expect(result.status).toBe("closed");
      expect(result.realizedPnl).toBe(45.15);
    });
  });

  // =========================================================================
  // Cluster D: Active position still returns status: "active"
  // =========================================================================
  describe("Cluster D: Active position still returns status: active", () => {
    it("szi=-30.1 (non-zero), normal active position → returns status: active, no realizedPnl", async () => {
      const config = makeConfig({
        positions: {
          "555": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("-30.1"),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "555");

      expect(result.status).toBe("active");
      expect(result.szi).toBe("-30.1");
      expect(result.unrealizedPnl).toBe(15.0);
      expect(result.realizedPnl).toBeUndefined();
      expect(result.closedAt).toBeUndefined();
      expect(result.closeReason).toBeUndefined();
      expect(result.entryPx).toBe(61.5);
      expect(result.markPx).toBe(62.0);
      expect(result.fundingEarned).toBe(0.5);
      expect(result.liquidationPx).toBe(50.0);
      expect(result.leverage).toEqual({ type: "cross", value: 1 });
    });

    it("szi=-0.001 (very small but non-zero), active position → returns status: active", async () => {
      const config = makeConfig({
        positions: {
          "666": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("-0.001"),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "666");

      expect(result.status).toBe("active");
      expect(result.szi).toBe("-0.001");
    });

    it("szi=1.5 (positive, long position), active → returns status: active", async () => {
      const config = makeConfig({
        positions: {
          "777": {
            openTx: "0xOPEN",
            hedge: { coin: "HYPE" },
          },
        },
      });

      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse((init?.body as string) ?? "{}");
        if (body.type === "clearinghouseState") {
          return {
            ok: true,
            status: 200,
            json: async () => buildClearinghouseState("1.5"),
          } as unknown as Response;
        }
        throw new Error(`Unexpected fetch: ${JSON.stringify(body)}`);
      }) as unknown as typeof fetch;

      const result = await getHedgeView(config, "777");

      expect(result.status).toBe("active");
      expect(result.szi).toBe("1.5");
    });
  });
});
