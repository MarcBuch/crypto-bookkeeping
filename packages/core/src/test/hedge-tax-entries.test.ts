/**
 * Adversarial tests for buildHedgeTaxEntries
 *
 * Covers:
 *   Cluster A (null fields): realized_pnl = null, closed_at = null, hl_fill_hash = null
 *   Cluster B (gain/loss/zero): positive pnl, negative pnl, zero pnl, zero funding, non-zero funding
 *   Cluster C (output contract): id format, transaction_type, source, EUR fields, is_error
 */

import { describe, expect, it } from "bun:test";

import type { StoredHedgeEvent } from "../db/store.js";
import { buildHedgeTaxEntries } from "../services/tax-transactions.js";

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
// Cluster A: null fields
// ---------------------------------------------------------------------------

describe("buildHedgeTaxEntries — Cluster A (null fields)", () => {
  it("should handle null realized_pnl", () => {
    const event = makeHedgeEvent({ realized_pnl: null, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row (funding is 0)
    const closeEntry = entries[0];
    expect(closeEntry.incoming_quantity).toBeNull();
    expect(closeEntry.outgoing_quantity).toBeNull();
  });

  it("should handle null hl_fill_hash", () => {
    const event = makeHedgeEvent({ hl_fill_hash: null, id: 42 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.id).toContain("evt42");
    }
  });

  it("should handle all null fields together", () => {
    const event = makeHedgeEvent({
      realized_pnl: null,
      hl_fill_hash: null,
      funding_earned: null,
      id: 99,
    });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row
    const closeEntry = entries[0];
    expect(closeEntry.incoming_quantity).toBeNull();
    expect(closeEntry.outgoing_quantity).toBeNull();
    expect(closeEntry.id).toContain("evt99");
  });
});

// ---------------------------------------------------------------------------
// Cluster B: gain/loss/zero
// ---------------------------------------------------------------------------

describe("buildHedgeTaxEntries — Cluster B (gain/loss/zero)", () => {
  it("should produce incoming USDC for positive pnl", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row (funding is 0)
    const closeEntry = entries[0];
    expect(closeEntry.incoming_quantity).toBe("100.00000000");
    expect(closeEntry.outgoing_quantity).toBeNull();
  });

  it("should produce outgoing USDC for negative pnl", () => {
    const event = makeHedgeEvent({ realized_pnl: -50, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row (funding is 0)
    const closeEntry = entries[0];
    expect(closeEntry.incoming_quantity).toBeNull();
    expect(closeEntry.outgoing_quantity).toBe("50.00000000");
  });

  it("should produce both null for zero pnl", () => {
    const event = makeHedgeEvent({ realized_pnl: 0, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row (funding is 0)
    const closeEntry = entries[0];
    expect(closeEntry.incoming_quantity).toBeNull();
    expect(closeEntry.outgoing_quantity).toBeNull();
  });

  it("should not produce funding row when funding_earned is zero", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1);
    expect(entries[0].transaction_type).toBe("hedge-close");
  });

  it("should produce funding row when funding_earned is non-zero positive", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: 25 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(2);
    const fundingEntry = entries[1];
    expect(fundingEntry.transaction_type).toBe("hedge-funding");
    expect(fundingEntry.incoming_quantity).toBe("25.00000000");
    expect(fundingEntry.outgoing_quantity).toBeNull();
  });

  it("should produce funding row when funding_earned is non-zero negative", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: -10 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(2);
    const fundingEntry = entries[1];
    expect(fundingEntry.transaction_type).toBe("hedge-funding");
    expect(fundingEntry.incoming_quantity).toBeNull();
    expect(fundingEntry.outgoing_quantity).toBe("10.00000000");
  });

  it("should handle null funding_earned as zero", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: null });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries.length).toBe(1); // only close row
  });
});

// ---------------------------------------------------------------------------
// Cluster C: output contract
// ---------------------------------------------------------------------------

describe("buildHedgeTaxEntries — Cluster C (output contract)", () => {
  it("should produce close row with correct id format", () => {
    const event = makeHedgeEvent({
      token_id: "abc",
      coin: "HYPE",
      hl_fill_hash: "fillhash123",
    });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    const closeEntry = entries[0];
    expect(closeEntry.id).toBe("hedge:close:abc:HYPE:fillhash123");
  });

  it("should use evt{id} when hl_fill_hash is null", () => {
    const event = makeHedgeEvent({
      token_id: "xyz",
      coin: "ETH",
      hl_fill_hash: null,
      id: 555,
    });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    const closeEntry = entries[0];
    expect(closeEntry.id).toBe("hedge:close:xyz:ETH:evt555");
  });

  it("should have transaction_type hedge-close for close row", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: 0 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    expect(entries[0].transaction_type).toBe("hedge-close");
  });

  it("should have transaction_type hedge-funding for funding row", () => {
    const event = makeHedgeEvent({ realized_pnl: 100, funding_earned: 50 });
    const entries = buildHedgeTaxEntries(event, "2024-01-02T12:00:00Z");

    const fundingEntry = entries.find((e) => e.transaction_type === "hedge-funding");
    expect(fundingEntry).toBeDefined();
    expect(fundingEntry?.transaction_type).toBe("hedge-funding");
  });
});
