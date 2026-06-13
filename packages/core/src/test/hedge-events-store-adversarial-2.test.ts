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
  insertHedgeEvent,
  closeHedgeEvent,
  getOpenHedgeEvent,
  getHedgeEvents,
} from "../db/store.js";
import type { StoredHedgeEvent } from "../db/store.js";

// Helper to create a minimal hedge event
function minimalHedgeEvent(
  tokenId: string,
  coin: string = "HYPE",
  overrides?: Partial<Omit<StoredHedgeEvent, "id">>,
): Omit<StoredHedgeEvent, "id"> {
  return {
    token_id: tokenId,
    coin,
    status: "open",
    entry_px: 100.5,
    size: 1.5,
    opened_at: new Date().toISOString(),
    closed_at: null,
    close_px: null,
    realized_pnl: null,
    funding_earned: null,
    close_reason: null,
    hl_fill_hash: null,
    ...overrides,
  };
}

describe("hedge-events-store — adversarial tests 2", () => {
  beforeEach(() => {
    // Create a fresh in-memory database for each test
    testDb = new Database(":memory:");
    initSchema(testDb);
  });

  // ============================================================================
  // Cluster D: Duplicate close via UNIQUE constraint
  // ============================================================================
  describe("Cluster D: Duplicate close via UNIQUE constraint", () => {
    it("closeHedgeEvent with same hl_fill_hash twice — second call returns existing closed row (idempotent)", () => {
      // Insert an open event
      const opened = insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // Close it with hl_fill_hash = "fill_abc123"
      const firstClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "fill_abc123",
      });

      expect(firstClose).toBeDefined();
      expect(firstClose?.id).toBe(opened.id);
      expect(firstClose?.hl_fill_hash).toBe("fill_abc123");
      expect(firstClose?.status).toBe("closed");

      // Call closeHedgeEvent again with the SAME hl_fill_hash
      const secondClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-02T00:00:00Z", // Different timestamp
        close_px: 106.0, // Different price
        realized_pnl: 5.5, // Different P&L
        funding_earned: 0.2, // Different funding
        close_reason: "different-reason",
        hl_fill_hash: "fill_abc123", // Same hash
      });

      // Must NOT throw, must return the existing closed row
      expect(secondClose).toBeDefined();
      expect(secondClose?.id).toBe(firstClose?.id);
      expect(secondClose?.hl_fill_hash).toBe("fill_abc123");
      expect(secondClose?.closed_at).toBe("2024-01-01T00:00:00Z"); // Original timestamp
      expect(secondClose?.close_px).toBe(105.0); // Original price
      expect(secondClose?.realized_pnl).toBe(4.5); // Original P&L
    });

    it("insert two separate open events for different coins, close both with different hashes — each returns its own closed row", () => {
      // Insert two open events for different coins
      const hypeEvent = insertHedgeEvent(
        minimalHedgeEvent("token-123", "HYPE", {
          entry_px: 100.0,
        }),
      );
      const ethEvent = insertHedgeEvent(
        minimalHedgeEvent("token-123", "ETH", {
          entry_px: 2000.0,
        }),
      );

      // Close HYPE with hash "fill_hype_001"
      const closedHype = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "fill_hype_001",
      });

      // Close ETH with hash "fill_eth_001"
      const closedEth = closeHedgeEvent({
        token_id: "token-123",
        coin: "ETH",
        closed_at: "2024-01-01T01:00:00Z",
        close_px: 2050.0,
        realized_pnl: 50.0,
        funding_earned: 0.2,
        close_reason: "manual",
        hl_fill_hash: "fill_eth_001",
      });

      // Verify each returns its own closed row
      expect(closedHype?.id).toBe(hypeEvent.id);
      expect(closedHype?.hl_fill_hash).toBe("fill_hype_001");
      expect(closedHype?.coin).toBe("HYPE");

      expect(closedEth?.id).toBe(ethEvent.id);
      expect(closedEth?.hl_fill_hash).toBe("fill_eth_001");
      expect(closedEth?.coin).toBe("ETH");

      // Verify they are different rows
      expect(closedHype?.id).not.toBe(closedEth?.id);
    });

    it("insertHedgeEvent with duplicate hl_fill_hash — throws UNIQUE constraint violation", () => {
      // Insert an open event with hl_fill_hash = "duplicate_hash"
      insertHedgeEvent(
        minimalHedgeEvent("token-123", "HYPE", {
          hl_fill_hash: "duplicate_hash",
        }),
      );

      // Try to insert another event with the same hl_fill_hash
      expect(() => {
        insertHedgeEvent(
          minimalHedgeEvent("token-456", "ETH", {
            hl_fill_hash: "duplicate_hash",
          }),
        );
      }).toThrow("UNIQUE constraint failed");
    });
  });

  // ============================================================================
  // Cluster E: Boundary conditions on getHedgeEvents ordering and completeness
  // ============================================================================
  describe("Cluster E: Boundary conditions on getHedgeEvents ordering and completeness", () => {
    it("insert 3 open events for same token_id at different timestamps — getHedgeEvents returns them newest-first", () => {
      const tokenId = "token-123";

      // Insert 3 open events with different timestamps, closing each before opening the next
      const event1 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-01T00:00:00Z",
          entry_px: 100.0,
        }),
      );

      // Close event1 before opening event2
      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-01T12:00:00Z",
        close_px: 100.5,
        realized_pnl: 0.5,
        funding_earned: 0.01,
        close_reason: "manual",
        hl_fill_hash: "hash-1",
      });

      const event2 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-02T00:00:00Z",
          entry_px: 101.0,
        }),
      );

      // Close event2 before opening event3
      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-02T12:00:00Z",
        close_px: 101.5,
        realized_pnl: 0.5,
        funding_earned: 0.01,
        close_reason: "manual",
        hl_fill_hash: "hash-2",
      });

      const event3 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-03T00:00:00Z",
          entry_px: 102.0,
        }),
      );

      const results = getHedgeEvents(tokenId);

      expect(results).toHaveLength(3);
      // Should be in descending order (newest first)
      expect(results[0].id).toBe(event3.id);
      expect(results[1].id).toBe(event2.id);
      expect(results[2].id).toBe(event1.id);
    });

    it("close one event — getHedgeEvents returns all 3 (open and closed mixed)", () => {
      const tokenId = "token-123";

      // Insert 3 open events, closing each before opening the next
      const event1 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-01T00:00:00Z",
        }),
      );

      // Close event1
      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-01T12:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-close-event1",
      });

      const event2 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-02T00:00:00Z",
        }),
      );

      // Close event2
      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-02T12:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-close-event2",
      });

      const event3 = insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-03T00:00:00Z",
        }),
      );

      const results = getHedgeEvents(tokenId);

      // Should return all 3 events (open and closed mixed)
      expect(results).toHaveLength(3);

      // Verify statuses
      const statuses = results.map((e) => e.status);
      expect(statuses).toContain("open");
      expect(statuses).toContain("closed");

      // Verify the closed events are in the results
      const foundClosedEvent1 = results.find((e) => e.id === event1.id);
      expect(foundClosedEvent1?.status).toBe("closed");

      const foundClosedEvent2 = results.find((e) => e.id === event2.id);
      expect(foundClosedEvent2?.status).toBe("closed");

      const foundOpenEvent = results.find((e) => e.id === event3.id);
      expect(foundOpenEvent?.status).toBe("open");
    });

    it("getOpenHedgeEvent after closing — returns null (no open event remaining after the one is closed)", () => {
      const tokenId = "token-123";

      // Insert an open event
      insertHedgeEvent(minimalHedgeEvent(tokenId, "HYPE"));

      // Verify it's open
      let openEvent = getOpenHedgeEvent(tokenId, "HYPE");
      expect(openEvent).toBeDefined();
      expect(openEvent?.status).toBe("open");

      // Close it
      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-01T12:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-close",
      });

      // Now getOpenHedgeEvent should return null
      openEvent = getOpenHedgeEvent(tokenId, "HYPE");
      expect(openEvent).toBeNull();
    });
  });

  // ============================================================================
  // Cluster F: Concurrent / race-like conditions (sequential simulation)
  // ============================================================================
  describe("Cluster F: Concurrent / race-like conditions (sequential simulation)", () => {
    it("simulate two simultaneous close attempts with same params — only one close sticks, no corruption", () => {
      // Insert an open event
      const opened = insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      const closeParams = {
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "fill_race_001",
      };

      // Call closeHedgeEvent twice in rapid succession (sequentially in test)
      const firstClose = closeHedgeEvent(closeParams);
      const secondClose = closeHedgeEvent(closeParams);

      // Both should succeed and return the same row
      expect(firstClose).toBeDefined();
      expect(secondClose).toBeDefined();
      expect(firstClose?.id).toBe(secondClose?.id);
      expect(firstClose?.id).toBe(opened.id);

      // Verify the row was only updated once (no double-write)
      const allEvents = getHedgeEvents("token-123");
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0].status).toBe("closed");
      expect(allEvents[0].hl_fill_hash).toBe("fill_race_001");
    });

    it("after double-close, verify DB row was only updated once and returned data is consistent", () => {
      // Insert an open event
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      const closeParams = {
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "fill_race_002",
      };

      // First close
      const firstClose = closeHedgeEvent(closeParams);

      // Second close with same params
      const secondClose = closeHedgeEvent(closeParams);

      // Verify consistency
      expect(firstClose?.closed_at).toBe(secondClose?.closed_at);
      expect(firstClose?.close_px).toBe(secondClose?.close_px);
      expect(firstClose?.realized_pnl).toBe(secondClose?.realized_pnl);
      expect(firstClose?.funding_earned).toBe(secondClose?.funding_earned);
      expect(firstClose?.close_reason).toBe(secondClose?.close_reason);
      expect(firstClose?.hl_fill_hash).toBe(secondClose?.hl_fill_hash);

      // Verify only one row exists in the database
      const allEvents = getHedgeEvents("token-123");
      expect(allEvents).toHaveLength(1);

      // Verify the row has the correct values
      const row = allEvents[0];
      expect(row.status).toBe("closed");
      expect(row.closed_at).toBe("2024-01-01T00:00:00Z");
      expect(row.close_px).toBe(105.0);
      expect(row.realized_pnl).toBe(4.5);
      expect(row.funding_earned).toBe(0.1);
      expect(row.close_reason).toBe("manual");
      expect(row.hl_fill_hash).toBe("fill_race_002");
    });

    it("double-close with different hl_fill_hash — second call returns null (no open event to close)", () => {
      // Insert an open event
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // First close with hash "fill_race_003"
      const firstClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "fill_race_003",
      });

      expect(firstClose).toBeDefined();

      // Second close with different hash "fill_race_004"
      const secondClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T01:00:00Z",
        close_px: 106.0,
        realized_pnl: 5.5,
        funding_earned: 0.2,
        close_reason: "manual",
        hl_fill_hash: "fill_race_004",
      });

      // Second close should return null (no open event to close)
      expect(secondClose).toBeNull();

      // Verify only one row exists with the first hash
      const allEvents = getHedgeEvents("token-123");
      expect(allEvents).toHaveLength(1);
      expect(allEvents[0].hl_fill_hash).toBe("fill_race_003");
    });
  });
});
