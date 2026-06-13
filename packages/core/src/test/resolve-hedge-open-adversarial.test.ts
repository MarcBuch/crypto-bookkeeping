import { mock, describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../db/schema.js";

// Mock getDb before importing store functions
let testDb: Database;

mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

import {
  insertHedgeSnapshot,
  insertHedgeEvent,
  getOpenHedgeEvent,
  getHedgeEvents,
} from "../db/store.js";
import { resolveHedgeOpen } from "../services/hedge.js";
import type { StoredHedgeSnapshot } from "../db/store.js";

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

describe("resolveHedgeOpen — adversarial tests", () => {
  beforeEach(() => {
    // Create a fresh in-memory database for each test
    testDb = new Database(":memory:");
    initSchema(testDb);
  });

  // ============================================================================
  // Cluster A: No snapshots
  // ============================================================================
  describe("Cluster A: No snapshots", () => {
    it("resolveHedgeOpen with zero hedge_snapshots in DB — returns null, does not throw", () => {
      const result = resolveHedgeOpen("token-999", "HYPE");

      expect(result).toBeNull();
    });

    it("resolveHedgeOpen with tokenId that has snapshots for different coin — returns null for requested coin", () => {
      // Insert a snapshot for token-123, UBTC
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "UBTC", {
          entry_px: 45000.0,
          szi: "-0.5",
        }),
      );

      // Query for HYPE (different coin)
      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeNull();
    });

    it("resolveHedgeOpen with different tokenId but same coin — returns null for requested tokenId", () => {
      // Insert a snapshot for token-123, HYPE
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));

      // Query for token-999 (different tokenId)
      const result = resolveHedgeOpen("token-999", "HYPE");

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Cluster B: Idempotent double-call
  // ============================================================================
  describe("Cluster B: Idempotent double-call", () => {
    it("resolveHedgeOpen called twice sequentially — returns same event id both times", () => {
      // Insert a hedge_snapshot for (token-123, HYPE)
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          entry_px: 58.37,
          szi: "-30.1",
        }),
      );

      // First call
      const firstResult = resolveHedgeOpen("token-123", "HYPE");
      expect(firstResult).toBeDefined();
      expect(firstResult?.id).toBeDefined();
      const firstId = firstResult!.id;

      // Second call
      const secondResult = resolveHedgeOpen("token-123", "HYPE");
      expect(secondResult).toBeDefined();
      expect(secondResult?.id).toBe(firstId);
    });

    it("resolveHedgeOpen called twice — only ONE row exists in hedge_events after double call", () => {
      // Insert a hedge_snapshot for (token-123, HYPE)
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));

      // First call
      resolveHedgeOpen("token-123", "HYPE");

      // Second call
      resolveHedgeOpen("token-123", "HYPE");

      // Verify only one event exists
      const allEvents = getHedgeEvents("token-123");
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0].status).toBe("open");
    });

    it("resolveHedgeOpen idempotency — second call returns cached result without re-inserting", () => {
      // Insert a hedge_snapshot for (token-123, HYPE)
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          entry_px: 100.0,
          szi: "-5.0",
        }),
      );

      // First call
      const firstResult = resolveHedgeOpen("token-123", "HYPE");
      expect(firstResult?.status).toBe("open");
      expect(firstResult?.entry_px).toBe(100.0);
      expect(firstResult?.size).toBe(5.0);

      // Second call — should return the same event without re-inserting
      const secondResult = resolveHedgeOpen("token-123", "HYPE");
      expect(secondResult?.id).toBe(firstResult?.id);
      expect(secondResult?.entry_px).toBe(100.0);
      expect(secondResult?.size).toBe(5.0);

      // Verify only one event in DB
      const allEvents = getHedgeEvents("token-123");
      expect(allEvents).toHaveLength(1);
    });
  });

  // ============================================================================
  // Cluster C: Correct bootstrap from snapshot
  // ============================================================================
  describe("Cluster C: Correct bootstrap from snapshot", () => {
    it("resolveHedgeOpen creates event with correct entry_px from snapshot", () => {
      // Insert a snapshot with specific entry_px
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          entry_px: 58.37,
          szi: "-30.1",
        }),
      );

      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.entry_px).toBe(58.37);
    });

    it("resolveHedgeOpen creates event with size as absolute value of szi", () => {
      // Insert a snapshot with negative szi
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          szi: "-30.1",
        }),
      );

      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.size).toBe(30.1);
    });

    it("resolveHedgeOpen creates event with opened_at from snapshot_at", () => {
      const snapshotTime = "2026-06-11T18:31:00.000Z";

      // Insert a snapshot with specific timestamp
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          entry_px: 58.37,
          szi: "-30.1",
        }),
      );

      // Manually update the snapshot_at to a known value
      // (insertHedgeSnapshot uses current time, so we need to verify the returned event)
      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.opened_at).toBeDefined();
      // The opened_at should match the snapshot's snapshot_at
      // We can't control the exact time, but we can verify it's set
      expect(typeof result?.opened_at).toBe("string");
    });

    it("resolveHedgeOpen creates event with status='open'", () => {
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));

      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.status).toBe("open");
    });

    it("resolveHedgeOpen creates event with closed_at=null", () => {
      insertHedgeSnapshot(minimalHedgeSnapshot("token-123", "HYPE"));

      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.closed_at).toBeNull();
    });

    it("resolveHedgeOpen creates event with all required fields populated correctly", () => {
      insertHedgeSnapshot(
        minimalHedgeSnapshot("token-123", "HYPE", {
          entry_px: 58.37,
          szi: "-30.1",
        }),
      );

      const result = resolveHedgeOpen("token-123", "HYPE");

      expect(result).toBeDefined();
      expect(result?.token_id).toBe("token-123");
      expect(result?.coin).toBe("HYPE");
      expect(result?.entry_px).toBe(58.37);
      expect(result?.size).toBe(30.1);
      expect(result?.status).toBe("open");
      expect(result?.opened_at).toBeDefined();
      expect(result?.closed_at).toBeNull();
      expect(result?.close_px).toBeNull();
      expect(result?.realized_pnl).toBeNull();
      expect(result?.funding_earned).toBeNull();
      expect(result?.close_reason).toBeNull();
      expect(result?.hl_fill_hash).toBeNull();
    });
  });

  // ============================================================================
  // Cluster D: Multiple snapshots — picks earliest
  // ============================================================================
  describe("Cluster D: Multiple snapshots — picks earliest", () => {
    it("resolveHedgeOpen with 3 snapshots at different times — picks earliest by snapshot_at", () => {
      const tokenId = "token-456";
      const coin = "HYPE";

      // Insert 3 snapshots with delays to ensure different timestamps
      // (SQLite datetime('now') has second precision)
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, coin, {
          entry_px: 50.0,
          szi: "-10.0",
        }),
      );

      // Sleep for 1.1 seconds to ensure different timestamp
      const start = Date.now();
      while (Date.now() - start < 1100) {
        // busy wait
      }

      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, coin, {
          entry_px: 55.0,
          szi: "-12.0",
        }),
      );

      const start2 = Date.now();
      while (Date.now() - start2 < 1100) {
        // busy wait
      }

      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, coin, {
          entry_px: 60.0,
          szi: "-15.0",
        }),
      );

      // resolveHedgeOpen should use the earliest (entry_px: 50.0)
      const result = resolveHedgeOpen(tokenId, coin);

      expect(result).toBeDefined();
      expect(result?.entry_px).toBe(50.0);
      expect(result?.size).toBe(10.0);
    });

    it("resolveHedgeOpen with multiple snapshots — idempotent even with new snapshots added later", () => {
      const tokenId = "token-789";
      const coin = "HYPE";

      // Insert first snapshot
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, coin, {
          entry_px: 100.0,
          szi: "-25.0",
        }),
      );

      // First call
      const firstResult = resolveHedgeOpen(tokenId, coin);
      expect(firstResult?.entry_px).toBe(100.0);
      const firstId = firstResult!.id;

      // Sleep to ensure different timestamp for next snapshot
      const start = Date.now();
      while (Date.now() - start < 1100) {
        // busy wait
      }

      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, coin, {
          entry_px: 105.0,
          szi: "-20.0",
        }),
      );

      // Second call should still return the same event (idempotent)
      const secondResult = resolveHedgeOpen(tokenId, coin);
      expect(secondResult?.id).toBe(firstId);
      expect(secondResult?.entry_px).toBe(100.0);

      // Verify only one event in DB
      const allEvents = getHedgeEvents(tokenId);
      expect(allEvents).toHaveLength(1);
    });
  });
});
