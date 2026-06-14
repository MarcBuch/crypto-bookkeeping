import { Database } from "bun:sqlite";
import { mock, describe, it, expect, beforeEach } from "bun:test";

import { initSchema } from "../db/schema.js";

// Mock getDb before importing store functions
let testDb: Database;

mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

import { insertHedgeSnapshot, listHedgeSnapshots } from "../db/store.js";
import type { StoredHedgeSnapshot } from "../db/store.js";

// Helper to create a minimal hedge snapshot
function minimalHedgeSnapshot(
  tokenId: string,
  overrides?: Partial<Omit<StoredHedgeSnapshot, "id" | "snapshot_at">>,
): Omit<StoredHedgeSnapshot, "id" | "snapshot_at"> {
  return {
    token_id: tokenId,
    coin: "HYPE",
    szi: "1.5",
    entry_px: 100.5,
    mark_px: 102.3,
    unrealized_pnl: 1.8,
    funding_earned: 0.05,
    liquidation_px: null,
    ...overrides,
  };
}

describe("hedge-db — listHedgeSnapshots and insertHedgeSnapshot", () => {
  beforeEach(() => {
    // Create a fresh in-memory database for each test
    testDb = new Database(":memory:");
    initSchema(testDb);
  });

  // Cluster A: listHedgeSnapshots — empty / boundary
  describe("Cluster A: empty results and ordering", () => {
    it("returns empty array for unknown tokenId", () => {
      const result = listHedgeSnapshots("unknown-token");
      expect(result).toEqual([]);
    });

    it("single snapshot round-trip — all fields correctly mapped", () => {
      const tokenId = "token-123";
      const snapshot = minimalHedgeSnapshot(tokenId, {
        coin: "HYPE",
        szi: "2.5",
        entry_px: 95.0,
        mark_px: 98.5,
        unrealized_pnl: 3.5,
        funding_earned: 0.1,
        liquidation_px: 85.0,
      });

      // Insert using the store function
      insertHedgeSnapshot(snapshot);

      const results = listHedgeSnapshots(tokenId);

      expect(results).toHaveLength(1);
      const retrieved = results[0];
      expect(retrieved.token_id).toBe(tokenId);
      expect(retrieved.coin).toBe("HYPE");
      expect(retrieved.szi).toBe("2.5");
      expect(retrieved.entry_px).toBe(95.0);
      expect(retrieved.mark_px).toBe(98.5);
      expect(retrieved.unrealized_pnl).toBe(3.5);
      expect(retrieved.funding_earned).toBe(0.1);
      expect(retrieved.liquidation_px).toBe(85.0);
      expect(retrieved.id).toBeDefined();
      expect(retrieved.snapshot_at).toBeDefined();
    });

    it("multiple snapshots ordered newest first", async () => {
      const tokenId = "token-456";

      // Insert first snapshot (older)
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, {
          szi: "1.0",
          entry_px: 100.0,
          mark_px: 101.0,
          unrealized_pnl: 1.0,
          funding_earned: 0.05,
        }),
      );

      // Add a longer delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Insert second snapshot (newer)
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId, {
          szi: "2.0",
          entry_px: 102.0,
          mark_px: 103.0,
          unrealized_pnl: 2.0,
          funding_earned: 0.1,
        }),
      );

      const results = listHedgeSnapshots(tokenId);

      expect(results).toHaveLength(2);
      // Newest first (by id as tiebreaker if timestamps are same)
      expect(results[0].szi).toBe("2.0");
      expect(results[0].mark_px).toBe(103.0);
      // Oldest second
      expect(results[1].szi).toBe("1.0");
      expect(results[1].mark_px).toBe(101.0);
    });
  });

  // Cluster B: insertHedgeSnapshot — nullable fields
  describe("Cluster B: nullable liquidation_px field", () => {
    it("null liquidationPx — read back as null (not 0, not undefined)", () => {
      const tokenId = "token-null-liq";
      const snapshot = minimalHedgeSnapshot(tokenId, {
        liquidation_px: null,
      });

      insertHedgeSnapshot(snapshot);

      const result = listHedgeSnapshots(tokenId)[0];

      expect(result.liquidation_px).toBeNull();
      expect(result.liquidation_px).not.toBe(0);
      expect(result.liquidation_px).not.toBeUndefined();
    });

    it("valid liquidationPx — read back correctly", () => {
      const tokenId = "token-valid-liq";
      const liquidationPrice = 85.5;
      const snapshot = minimalHedgeSnapshot(tokenId, {
        liquidation_px: liquidationPrice,
      });

      insertHedgeSnapshot(snapshot);

      const result = listHedgeSnapshots(tokenId)[0];

      expect(result.liquidation_px).toBe(liquidationPrice);
      expect(result.liquidation_px).not.toBeNull();
    });
  });

  // Cluster C: Isolation
  describe("Cluster C: tokenId isolation", () => {
    it("different tokenIds are isolated — query for one returns only that token's snapshots", () => {
      const tokenId1 = "111";
      const tokenId2 = "222";

      // Insert snapshots for token 111
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId1, {
          szi: "1.0",
          entry_px: 100.0,
          mark_px: 101.0,
          unrealized_pnl: 1.0,
          funding_earned: 0.05,
        }),
      );

      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId1, {
          szi: "1.5",
          entry_px: 100.5,
          mark_px: 101.5,
          unrealized_pnl: 1.5,
          funding_earned: 0.06,
        }),
      );

      // Insert snapshots for token 222
      insertHedgeSnapshot(
        minimalHedgeSnapshot(tokenId2, {
          szi: "2.0",
          entry_px: 102.0,
          mark_px: 103.0,
          unrealized_pnl: 2.0,
          funding_earned: 0.1,
        }),
      );

      // Query for token 111
      const results111 = listHedgeSnapshots(tokenId1);

      // Query for token 222
      const results222 = listHedgeSnapshots(tokenId2);

      // Token 111 should have 2 snapshots
      expect(results111).toHaveLength(2);
      expect(results111.every((s) => s.token_id === tokenId1)).toBe(true);

      // Token 222 should have 1 snapshot
      expect(results222).toHaveLength(1);
      expect(results222[0].token_id).toBe(tokenId2);

      // Verify no cross-contamination
      expect(results111.some((s) => s.token_id === tokenId2)).toBe(false);
      expect(results222.some((s) => s.token_id === tokenId1)).toBe(false);
    });
  });
});
