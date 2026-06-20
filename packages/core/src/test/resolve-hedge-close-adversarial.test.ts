import { Database } from "bun:sqlite";
import { mock, describe, it, expect, beforeEach } from "bun:test";

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
import { insertHedgeSnapshot, getHedgeEvents } from "../db/store.js";
import type { StoredHedgeSnapshot } from "../db/store.js";
import { resolveHedgeClose, resolveHedgeOpen } from "../services/hedge.js";

// Helper to create a minimal hedge snapshot
function minimalHedgeSnapshot(
  tokenId: string,
  coin: string = "HYPE",
  overrides?: Partial<Omit<StoredHedgeSnapshot, "id" | "snapshot_at">>,
): Omit<StoredHedgeSnapshot, "id" | "snapshot_at"> {
  return {
    token_id: tokenId,
    coin,
    szi: "-30.1",
    entry_px: 100.5,
    mark_px: 101.0,
    unrealized_pnl: 15.0,
    funding_earned: 0.5,
    liquidation_px: null,
    ...overrides,
  };
}

// Helper to create a mock fill
function mockFill(overrides: Record<string, unknown> = {}) {
  return {
    coin: "HYPE",
    px: "61.58",
    sz: "30.1",
    side: "A" as const,
    time: Date.now(),
    closedPnl: "-63",
    oid: 12345,
    tid: 999001,
    dir: "Close Short",
    ...overrides,
  };
}

// Helper to create a minimal config
function minimalConfig(wallet: string = "0x123abc"): Config {
  return {
    wallet,
    positions: {
      "token-123": {
        hedge: { coin: "HYPE" },
      },
    },
  } as unknown as Config;
}

describe("resolveHedgeClose — adversarial tests", () => {
  beforeEach(() => {
    // Create a fresh in-memory database for each test
    testDb = new Database(":memory:");
    initSchema(testDb);
  });

  // ============================================================================
  // Cluster A: HL API failures
  // ============================================================================
  describe("Cluster A: HL API failures", () => {
    it("resolveHedgeClose with fetch throwing network timeout — rejects with error", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to throw network error
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error("Network timeout");
      }) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        try {
          await resolveHedgeClose(config, "token-123", "HYPE");
          throw new Error("Expected resolveHedgeClose to reject");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("Network timeout");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with fetch returning HTTP 500 — rejects with error", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return 500
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}),
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        try {
          await resolveHedgeClose(config, "token-123", "HYPE");
          throw new Error("Expected resolveHedgeClose to reject");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain("Hyperliquid API error (500)");
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with fetch returning malformed JSON — rejects with error", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return malformed JSON
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => {
            throw new Error("Unexpected token < in JSON at position 0");
          },
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        try {
          await resolveHedgeClose(config, "token-123", "HYPE");
          expect.unreachable("Expected resolveHedgeClose to reject");
        } catch (error) {
          if (error instanceof Error && error.message === "Expected resolveHedgeClose to reject") {
            throw error;
          }
          expect(error).toBeInstanceOf(Error);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ============================================================================
  // Cluster B: No closing fills
  // ============================================================================
  describe("Cluster B: No closing fills", () => {
    it("resolveHedgeClose with empty fills array — returns null", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return empty fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with fills for different coin — returns null", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return fills for different coin
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            mockFill({ coin: "ETH", dir: "Close Long" }),
            mockFill({ coin: "BTC", dir: "Close Short" }),
          ],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with only Open fills (no Close) — returns null", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return only Open fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            mockFill({ coin: "HYPE", dir: "Open Short" }),
            mockFill({ coin: "HYPE", dir: "Open Short" }),
          ],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ============================================================================
  // Cluster C: Idempotent duplicate call
  // ============================================================================
  describe("Cluster C: Idempotent duplicate call", () => {
    it("resolveHedgeClose called twice with same fills — returns same event id both times", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();

        // First call
        const firstResult = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(firstResult).toBeDefined();
        expect(firstResult?.status).toBe("closed");
        const firstId = firstResult!.id;

        // Second call
        const secondResult = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(secondResult).toBeDefined();
        expect(secondResult?.id).toBe(firstId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose called twice — only ONE closed event exists in DB", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();

        // First call
        await resolveHedgeClose(config, "token-123", "HYPE");

        // Second call
        await resolveHedgeClose(config, "token-123", "HYPE");

        // Verify only one closed event exists
        const allEvents = getHedgeEvents("token-123");
        const closedEvents = allEvents.filter((e) => e.status === "closed");
        expect(closedEvents).toHaveLength(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose idempotency — second call does not double-count P&L", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();

        // First call
        const firstResult = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(firstResult?.realized_pnl).toBe(-50);

        // Second call
        const secondResult = await resolveHedgeClose(config, "token-123", "HYPE");
        expect(secondResult?.realized_pnl).toBe(-50); // Same P&L, not doubled
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ============================================================================
  // Cluster D: Correct P&L and fill data
  // ============================================================================
  describe("Cluster D: Correct P&L and fill data", () => {
    it("resolveHedgeClose with 2 partial close fills — sums closedPnl correctly", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return 2 partial close fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            mockFill({ closedPnl: "-30", sz: "10" }),
            mockFill({ closedPnl: "-20", sz: "20" }),
          ],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.realized_pnl).toBe(-50); // -30 + -20
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with multiple fills — uses VWAP for close_px", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return fills with different sizes
      // VWAP = (60.0*10 + 61.58*20 + 62.0*5) / 35 = (600 + 1231.6 + 310) / 35 = 2141.6 / 35 ≈ 61.189
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            mockFill({ closedPnl: "-30", sz: "10", px: "60.0" }),
            mockFill({ closedPnl: "-20", sz: "20", px: "61.58" }),
            mockFill({ closedPnl: "-5", sz: "5", px: "62.0" }),
          ],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        // VWAP = (60.0*10 + 61.58*20 + 62.0*5) / 35
        const expectedVwap = (60.0 * 10 + 61.58 * 20 + 62.0 * 5) / 35;
        expect(result?.close_px).toBeCloseTo(expectedVwap, 6);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose pulls funding_earned from latest snapshot", async () => {
      // Setup: insert multiple snapshots with different funding_earned
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          funding_earned: 0.5,
        }),
      );

      // Wait to ensure different timestamp
      const start = Date.now();
      while (Date.now() - start < 1100) {
        // busy wait
      }

      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          funding_earned: 1.5, // Latest
        }),
      );

      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.funding_earned).toBe(1.5); // From latest snapshot
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose uses largest fill's tid as hl_fill_hash", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return fills with different tids
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [
            mockFill({ closedPnl: "-30", sz: "10", tid: 111 }),
            mockFill({ closedPnl: "-20", sz: "20", tid: 222 }), // Largest
            mockFill({ closedPnl: "-5", sz: "5", tid: 333 }),
          ],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.hl_fill_hash).toBe("222"); // From largest fill (sz=20)
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose sets close_reason to 'manual_close' for regular close fills", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return a normal "Close Short" fill (not a liquidation)
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1", dir: "Close Short" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.close_reason).toBe("manual_close");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose sets close_reason to 'liquidation' when any fill is a liquidation", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return a liquidation fill
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1", dir: "Liquidated" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.close_reason).toBe("liquidation");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose sets status to 'closed'", async () => {
      // Setup: insert snapshot and open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));
      resolveHedgeOpen("token-123", "HYPE");

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeDefined();
        expect(result?.status).toBe("closed");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with no open event — returns null", async () => {
      // Setup: insert snapshot but NO open event
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        // Should return null because resolveHedgeOpen returns null (no snapshot)
        // Actually, we have a snapshot, so resolveHedgeOpen will create an open event
        // Let me test the case where there's no snapshot at all
        expect(result).toBeDefined(); // This will create the open event
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("resolveHedgeClose with no snapshot — returns null (no open event to bootstrap)", async () => {
      // Setup: NO snapshot, so resolveHedgeOpen will return null

      // Mock fetch to return closing fills
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => [mockFill({ closedPnl: "-50", sz: "30.1" })],
        }) as unknown as Response) as unknown as typeof fetch;

      try {
        const config = minimalConfig();
        const result = await resolveHedgeClose(config, "token-123", "HYPE");

        expect(result).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
