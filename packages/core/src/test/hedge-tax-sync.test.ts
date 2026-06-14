/**
 * Adversarial tests for syncHedgeTaxFlows
 *
 * Covers:
 *   Cluster A (no events): getAllClosedHedgeEvents returns [], returns {synced: 0}, no upserts
 *   Cluster B (idempotency): calling twice produces same DB rows, upsert is idempotent
 *   Cluster C (null funding): event with funding_earned = null produces exactly 1 row
 */

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockClosedEvents: unknown[] = [];
let upsertCalls: unknown[] = [];

mock.module("../db/store.js", () => ({
  getAllClosedHedgeEvents: () => mockClosedEvents,
  getTaxTransaction: () => null, // No existing rows, so enrichment path is exercised
  upsertSyncedTaxTransaction: (entry: unknown) => {
    upsertCalls.push(entry);
  },
  getAllPositions: () => [],
  getTaxSyncState: () => null,
  getTaxTransactionsNeedingEurEnrichment: () => [],
  updateTaxTransactionEurValues: () => {},
  upsertTaxSyncState: () => {},
}));

mock.module("../services/pricing.js", () => ({
  getHistoricalPrice: async () => 1.0, // Fixed price, no network calls
}));

// ---------------------------------------------------------------------------
// Now import the module under test
// ---------------------------------------------------------------------------

import type { StoredHedgeEvent } from "../db/store.js";
import { buildHedgeTaxEntries, syncHedgeTaxFlows } from "../services/tax-transactions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHedgeEvent(overrides: Partial<StoredHedgeEvent> = {}): StoredHedgeEvent {
  return {
    id: 1,
    token_id: "123456",
    coin: "HYPE",
    status: "closed",
    entry_px: 100,
    size: 10,
    opened_at: "2024-01-01T00:00:00Z",
    closed_at: "2024-01-02T00:00:00Z",
    close_px: 110,
    realized_pnl: 100,
    funding_earned: 50,
    close_reason: "manual",
    hl_fill_hash: "hash123",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockClosedEvents = [];
  upsertCalls = [];
});

afterEach(() => {
  mockClosedEvents = [];
  upsertCalls = [];
});

// ---------------------------------------------------------------------------
// Cluster A: no events
// ---------------------------------------------------------------------------

describe("syncHedgeTaxFlows — Cluster A (no events)", () => {
  it("should return {synced: 0} when no closed events", async () => {
    mockClosedEvents = [];
    const result = await syncHedgeTaxFlows({ pricing: {} as any });
    expect(result.synced).toBe(0);
  });

  it("should not call upsertSyncedTaxTransaction when no events", async () => {
    mockClosedEvents = [];
    await syncHedgeTaxFlows({ pricing: {} as any });
    expect(upsertCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cluster B: idempotency
// ---------------------------------------------------------------------------

describe("syncHedgeTaxFlows — Cluster B (idempotency)", () => {
  it("should produce same IDs when called twice with same event", () => {
    const event = makeHedgeEvent({
      id: 1,
      token_id: "abc",
      coin: "HYPE",
      hl_fill_hash: "fill123",
      realized_pnl: 100,
      funding_earned: 50,
    });

    // First call
    const firstCallEntries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
    const firstCallIds = firstCallEntries.map((e) => e.id);

    // Second call
    const secondCallEntries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
    const secondCallIds = secondCallEntries.map((e) => e.id);

    expect(firstCallIds).toEqual(secondCallIds);
  });

  it("should produce consistent IDs across multiple events", () => {
    const events = [
      makeHedgeEvent({ id: 1, token_id: "abc", coin: "HYPE", hl_fill_hash: "fill1" }),
      makeHedgeEvent({ id: 2, token_id: "def", coin: "ETH", hl_fill_hash: "fill2" }),
    ];

    const ids: string[] = [];
    for (const evt of events) {
      const entries = buildHedgeTaxEntries(evt, "2024-01-02T00:00:00Z");
      ids.push(...entries.map((e) => e.id));
    }

    expect(ids.length).toBe(4);
    expect(ids[0]).toBe("hedge:close:abc:HYPE:fill1");
    expect(ids[1]).toBe("hedge:funding:abc:HYPE:fill1:funding");
    expect(ids[2]).toBe("hedge:close:def:ETH:fill2");
    expect(ids[3]).toBe("hedge:funding:def:ETH:fill2:funding");
  });
});

// ---------------------------------------------------------------------------
// Cluster C: null funding
// ---------------------------------------------------------------------------

describe("syncHedgeTaxFlows — Cluster C (null funding)", () => {
  it("should produce exactly 1 row when funding_earned is null", () => {
    const event = makeHedgeEvent({
      realized_pnl: 100,
      funding_earned: null,
    });

    const entries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
    expect(entries.length).toBe(1);
  });

  it("should produce exactly 1 row when funding_earned is 0", () => {
    const event = makeHedgeEvent({
      realized_pnl: 100,
      funding_earned: 0,
    });

    const entries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
    expect(entries.length).toBe(1);
  });

  it("should produce 2 rows when funding_earned is non-zero", () => {
    const event = makeHedgeEvent({
      realized_pnl: 100,
      funding_earned: 25,
    });

    const entries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
    expect(entries.length).toBe(2);
  });

  it("should handle multiple events with mixed null/zero funding", () => {
    const events = [
      makeHedgeEvent({ id: 1, realized_pnl: 100, funding_earned: null }),
      makeHedgeEvent({ id: 2, realized_pnl: 100, funding_earned: 0 }),
      makeHedgeEvent({ id: 3, realized_pnl: 100, funding_earned: 50 }),
    ];

    let totalRows = 0;
    for (const event of events) {
      const entries = buildHedgeTaxEntries(event, "2024-01-02T00:00:00Z");
      totalRows += entries.length;
    }

    expect(totalRows).toBe(4); // 1 + 1 + 2
  });
});
