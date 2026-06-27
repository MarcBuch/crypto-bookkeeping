import { Database } from "bun:sqlite";
import { mock, describe, it, expect, beforeEach } from "bun:test";

import { createHedgeStore } from "../db/hedge-store.js";
import { initSchema } from "../db/schema.js";

// Mock getDb before importing store functions
let testDb: Database;

await mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

import {
  insertHedgeEvent,
  closeHedgeEvent,
  getAllClosedHedgeEvents,
  getEarliestHedgeSnapshot,
  getOpenHedgeEvent,
  getHedgeEvents,
  insertHedgeSnapshot,
  listHedgeSnapshots,
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

describe("hedge-events-store — adversarial tests", () => {
  beforeEach(() => {
    // Create a fresh in-memory database for each test
    testDb = new Database(":memory:");
    initSchema(testDb);
  });

  const hedgeStore = createHedgeStore({
    closeHedgeEvent,
    getAllClosedHedgeEvents,
    getEarliestHedgeSnapshot,
    getHedgeEvents,
    getOpenHedgeEvent,
    insertHedgeEvent,
    insertHedgeSnapshot,
    listHedgeSnapshots,
  });

  // ============================================================================
  // Cluster A: Invalid/missing required fields
  // ============================================================================
  describe("Cluster A: Invalid/missing required fields", () => {
    it("insertHedgeEvent with empty string token_id — inserts successfully (SQLite allows empty strings)", () => {
      const event = minimalHedgeEvent("", "HYPE");
      const result = insertHedgeEvent(event);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.token_id).toBe("");
      expect(result.coin).toBe("HYPE");
    });

    it("insertHedgeEvent with empty string coin — inserts successfully (SQLite allows empty strings)", () => {
      const event = minimalHedgeEvent("token-123", "");
      const result = insertHedgeEvent(event);

      expect(result).toBeDefined();
      expect(result.id).toBeDefined();
      expect(result.token_id).toBe("token-123");
      expect(result.coin).toBe("");
    });

    it("insertHedgeEvent with NaN as entry_px — throws NOT NULL constraint error (entry_px is NOT NULL)", () => {
      const event = minimalHedgeEvent("token-123", "HYPE", {
        entry_px: NaN,
      });

      // SQLite has NOT NULL constraint on entry_px, so NaN (which becomes NULL) violates it
      expect(() => insertHedgeEvent(event)).toThrow("NOT NULL constraint failed");
    });

    it("insertHedgeEvent with NaN as size — throws NOT NULL constraint error (size is NOT NULL)", () => {
      const event = minimalHedgeEvent("token-123", "HYPE", {
        size: NaN,
      });

      // SQLite has NOT NULL constraint on size, so NaN (which becomes NULL) violates it
      expect(() => insertHedgeEvent(event)).toThrow("NOT NULL constraint failed");
    });

    it("getOpenHedgeEvent with empty string token_id — returns null (no match)", () => {
      // Insert an event with a real token_id
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // Query with empty string token_id
      const result = getOpenHedgeEvent("", "HYPE");

      expect(result).toBeNull();
    });

    it("getHedgeEvents with token_id that has no events — returns empty array", () => {
      // Insert events for a different token
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));
      insertHedgeEvent(minimalHedgeEvent("token-123", "ETH")); // Different coin to avoid UNIQUE constraint

      // Query for a token with no events
      const result = getHedgeEvents("token-999");

      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("getHedgeEvents with empty string token_id — returns empty array (no match)", () => {
      // Insert events with real token_ids
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));
      insertHedgeEvent(minimalHedgeEvent("token-456", "HYPE"));

      // Query with empty string token_id
      const result = getHedgeEvents("");

      expect(result).toEqual([]);
    });
  });

  // ============================================================================
  // Cluster B: Close-before-open and idempotency
  // ============================================================================
  describe("Cluster B: Close-before-open and idempotency", () => {
    it("scoped HedgeStore allows only one open event per token/coin lifecycle", () => {
      const first = hedgeStore.recordEvent(minimalHedgeEvent("token-scope", "HYPE"));

      expect(() =>
        hedgeStore.recordEvent(
          minimalHedgeEvent("token-scope", "HYPE", {
            entry_px: 101,
            size: 2,
          }),
        ),
      ).toThrow("UNIQUE constraint failed");

      expect(
        hedgeStore.closeOpenEvent({
          token_id: "token-scope",
          coin: "HYPE",
          closed_at: "2024-01-01T12:00:00Z",
          close_px: 105,
          realized_pnl: 4.5,
          funding_earned: 0.1,
          close_reason: "manual",
          hl_fill_hash: "scope-close-1",
        }),
      )?.toMatchObject({ id: first.id, status: "closed" });

      const reopened = hedgeStore.recordEvent(
        minimalHedgeEvent("token-scope", "HYPE", {
          opened_at: "2024-01-02T00:00:00Z",
          entry_px: 110,
          size: 1,
        }),
      );

      expect(hedgeStore.findOpenEvent("token-scope", "HYPE")?.id).toBe(reopened.id);
      expect(hedgeStore.listEvents("token-scope")).toHaveLength(2);
      expect(
        hedgeStore
          .listEvents("token-scope")
          .filter((event) => event.coin === "HYPE" && event.status === "open"),
      ).toHaveLength(1);
    });

    it("scoped HedgeStore closes idempotently by fill hash", () => {
      const opened = hedgeStore.recordEvent(minimalHedgeEvent("token-idempotent", "HYPE"));

      const firstClose = hedgeStore.closeOpenEvent({
        token_id: "token-idempotent",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "scope-fill-1",
      });
      const secondClose = hedgeStore.closeOpenEvent({
        token_id: "token-idempotent",
        coin: "HYPE",
        closed_at: "2024-01-02T00:00:00Z",
        close_px: 999,
        realized_pnl: 999,
        funding_earned: 999,
        close_reason: "different",
        hl_fill_hash: "scope-fill-1",
      });

      expect(firstClose?.id).toBe(opened.id);
      expect(secondClose).toMatchObject({
        id: firstClose?.id,
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105,
        realized_pnl: 4.5,
        hl_fill_hash: "scope-fill-1",
      });
      expect(
        hedgeStore.listClosedEvents().filter((event) => event.hl_fill_hash === "scope-fill-1"),
      ).toHaveLength(1);
    });

    it("insertHedgeEvent with duplicate (token_id, coin) when first is open — throws UNIQUE constraint error", () => {
      // Insert an open event for token-123, HYPE
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // Try to insert another open event for the same token_id and coin
      const duplicateEvent = minimalHedgeEvent("token-123", "HYPE", {
        entry_px: 101.0, // Different price
        size: 2.0, // Different size
      });

      expect(() => insertHedgeEvent(duplicateEvent)).toThrow("UNIQUE constraint failed");
    });

    it("insertHedgeEvent can insert second open after closing the first — succeeds", () => {
      // Insert and close an open event for token-123, HYPE
      const firstOpen = insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));
      expect(firstOpen.status).toBe("open");

      // Close it
      const closed = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: new Date().toISOString(),
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-first-close",
      });

      expect(closed).toBeDefined();
      expect(closed?.status).toBe("closed");

      // Now insert another open event for the same token_id and coin — should succeed
      const secondOpen = insertHedgeEvent(
        minimalHedgeEvent("token-123", "HYPE", {
          entry_px: 102.0,
          size: 1.0,
        }),
      );

      expect(secondOpen).toBeDefined();
      expect(secondOpen.status).toBe("open");
      expect(secondOpen.id).not.toBe(firstOpen.id);
    });

    it("closeHedgeEvent when no open event exists for (token_id, coin) — returns null, does not throw", () => {
      // Try to close an event that was never opened
      const result = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: new Date().toISOString(),
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-123",
      });

      expect(result).toBeNull();
    });

    it("closeHedgeEvent on a row that is already closed — returns null (no open event to close)", () => {
      // Insert and close an event
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      const closed = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: new Date().toISOString(),
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-123",
      });

      expect(closed).toBeDefined();
      expect(closed?.status).toBe("closed");

      // Try to close again (no open event exists anymore)
      const result = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: new Date().toISOString(),
        close_px: 106.0,
        realized_pnl: 5.5,
        funding_earned: 0.2,
        close_reason: "manual",
        hl_fill_hash: "hash-456",
      });

      expect(result).toBeNull();
    });

    it("closeHedgeEvent with same hl_fill_hash — returns existing closed event (idempotency)", () => {
      // Insert and close an event
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      const firstClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-idempotent",
      });

      expect(firstClose).toBeDefined();
      expect(firstClose?.hl_fill_hash).toBe("hash-idempotent");

      // Try to close again with the same hl_fill_hash
      const secondClose = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-02T00:00:00Z", // Different timestamp
        close_px: 106.0, // Different price
        realized_pnl: 5.5, // Different P&L
        funding_earned: 0.2, // Different funding
        close_reason: "different-reason",
        hl_fill_hash: "hash-idempotent", // Same hash
      });

      // Should return the existing closed event, not create a new one
      expect(secondClose).toBeDefined();
      expect(secondClose?.id).toBe(firstClose?.id);
      expect(secondClose?.closed_at).toBe("2024-01-01T00:00:00Z"); // Original timestamp
      expect(secondClose?.close_px).toBe(105.0); // Original price
      expect(secondClose?.realized_pnl).toBe(4.5); // Original P&L
    });

    it("closeHedgeEvent with different coin — returns null (no matching open event)", () => {
      // Insert an event for HYPE
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // Try to close with a different coin
      const result = closeHedgeEvent({
        token_id: "token-123",
        coin: "ETH", // Different coin
        closed_at: new Date().toISOString(),
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-123",
      });

      expect(result).toBeNull();
    });

    it("closeHedgeEvent with different token_id — returns null (no matching open event)", () => {
      // Insert an event for token-123
      insertHedgeEvent(minimalHedgeEvent("token-123", "HYPE"));

      // Try to close with a different token_id
      const result = closeHedgeEvent({
        token_id: "token-999", // Different token
        coin: "HYPE",
        closed_at: new Date().toISOString(),
        close_px: 105.0,
        realized_pnl: 4.5,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-123",
      });

      expect(result).toBeNull();
    });

    it("closeHedgeEvent successfully closes an open event and updates all fields", () => {
      // Insert an open event
      const opened = insertHedgeEvent(
        minimalHedgeEvent("token-123", "HYPE", {
          entry_px: 100.0,
          size: 2.0,
        }),
      );

      expect(opened.status).toBe("open");
      expect(opened.closed_at).toBeNull();
      expect(opened.close_px).toBeNull();
      expect(opened.realized_pnl).toBeNull();
      expect(opened.funding_earned).toBeNull();

      // Close the event
      const closed = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T12:00:00Z",
        close_px: 105.0,
        realized_pnl: 10.0,
        funding_earned: 0.5,
        close_reason: "stop-loss",
        hl_fill_hash: "hash-close-123",
      });

      expect(closed).toBeDefined();
      expect(closed?.id).toBe(opened.id);
      expect(closed?.status).toBe("closed");
      expect(closed?.closed_at).toBe("2024-01-01T12:00:00Z");
      expect(closed?.close_px).toBe(105.0);
      expect(closed?.realized_pnl).toBe(10.0);
      expect(closed?.funding_earned).toBe(0.5);
      expect(closed?.close_reason).toBe("stop-loss");
      expect(closed?.hl_fill_hash).toBe("hash-close-123");
    });
  });

  // ============================================================================
  // Cluster C: Data isolation and consistency
  // ============================================================================
  describe("Cluster C: Data isolation and consistency", () => {
    it("multiple open events for same token_id but different coins — closeHedgeEvent closes only the matching coin", () => {
      // Insert open events for the same token but different coins
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

      // Close only the HYPE event
      const closedHype = closeHedgeEvent({
        token_id: "token-123",
        coin: "HYPE",
        closed_at: "2024-01-01T00:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-hype",
      });

      expect(closedHype?.id).toBe(hypeEvent.id);
      expect(closedHype?.status).toBe("closed");

      // Verify ETH event is still open
      const ethStillOpen = getOpenHedgeEvent("token-123", "ETH");
      expect(ethStillOpen).toBeDefined();
      expect(ethStillOpen?.id).toBe(ethEvent.id);
      expect(ethStillOpen?.status).toBe("open");
    });

    it("getHedgeEvents returns all events for a token_id in descending opened_at order", () => {
      const tokenId = "token-123";

      // Insert events with different timestamps, closing each before opening the next
      insertHedgeEvent(
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

      insertHedgeEvent(
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

      insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-03T00:00:00Z",
          entry_px: 102.0,
        }),
      );

      const results = getHedgeEvents(tokenId);

      expect(results).toHaveLength(3);
      // Should be in descending order (newest first)
      expect(results[0].opened_at).toBe("2024-01-03T00:00:00Z");
      expect(results[1].opened_at).toBe("2024-01-02T00:00:00Z");
      expect(results[2].opened_at).toBe("2024-01-01T00:00:00Z");
    });

    it("getHedgeEvents includes both open and closed events", () => {
      const tokenId = "token-123";

      // Insert and close an event
      insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-01T00:00:00Z",
        }),
      );

      closeHedgeEvent({
        token_id: tokenId,
        coin: "HYPE",
        closed_at: "2024-01-01T12:00:00Z",
        close_px: 105.0,
        realized_pnl: 5.0,
        funding_earned: 0.1,
        close_reason: "manual",
        hl_fill_hash: "hash-123",
      });

      // Insert another open event
      insertHedgeEvent(
        minimalHedgeEvent(tokenId, "HYPE", {
          opened_at: "2024-01-02T00:00:00Z",
        }),
      );

      const results = getHedgeEvents(tokenId);

      expect(results).toHaveLength(2);
      // Should include both open and closed events
      const statuses = results.map((e) => e.status);
      expect(statuses).toContain("open");
      expect(statuses).toContain("closed");
    });
  });
});
