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

import { insertHedgeSnapshot, listHedgeSnapshots } from "../db/store.js";
import type { StoredHedgeEvent, StoredHedgeSnapshot } from "../db/store.js";

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

  describe("hedge_events schema migration", () => {
    it("normalizes legacy closed fill rows to fill trade_key while preserving tax_key", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT
        );
      `);
      legacyDb.run(
        `INSERT INTO hedge_events
         (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "token-123",
          "HYPE",
          "closed",
          100,
          1.5,
          "2024-01-01T00:00:00Z",
          "2024-01-01T12:00:00Z",
          105,
          7.5,
          0.25,
          "manual",
          "fill-legacy-1",
          "trade:legacy:token-123:HYPE:2024-01-01T00:00:00Z:100:1.5",
          "tax:manual:preserve-me",
        ],
      );

      initSchema(legacyDb);

      const migrated = legacyDb
        .query<StoredHedgeEvent, []>(
          "SELECT * FROM hedge_events WHERE hl_fill_hash = 'fill-legacy-1'",
        )
        .get();
      expect(migrated?.trade_key).toBe("trade:fill:HYPE:fill-legacy-1");
      expect(migrated?.tax_key).toBe("tax:manual:preserve-me");

      const tradeIndex = legacyDb
        .query<{ name: string; unique: number }, []>("PRAGMA index_list('hedge_events')")
        .all()
        .find((index) => index.name === "idx_hedge_events_trade_key");
      expect(tradeIndex?.unique).toBe(1);
    });

    it("preserves assigned token_id when migrating legacy NOT NULL rows and makes token_id nullable", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT NOT NULL,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT
        );
      `);
      legacyDb.run(
        `INSERT INTO hedge_events
         (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "token-assigned",
          "HYPE",
          "open",
          100,
          1.5,
          "2024-01-01T00:00:00Z",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      );

      initSchema(legacyDb);

      const migrated = legacyDb
        .query<Pick<StoredHedgeEvent, "token_id" | "coin" | "trade_key" | "tax_key">, []>(
          "SELECT token_id, coin, trade_key, tax_key FROM hedge_events WHERE id = 1",
        )
        .get();
      const tokenIdColumn = legacyDb
        .query<{ name: string; notnull: number }, []>("PRAGMA table_info('hedge_events')")
        .all()
        .find((column) => column.name === "token_id");

      expect(migrated).toEqual({
        token_id: "token-assigned",
        coin: "HYPE",
        trade_key: "trade:legacy:token-assigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:1",
        tax_key: "tax:legacy:token-assigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:1",
      });
      expect(tokenIdColumn?.notnull).toBe(0);
    });

    it("preserves null token assignment on current-schema rows while backfilling keys and index", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT,
          current_szi TEXT,
          mark_px REAL,
          unrealized_pnl REAL,
          liquidation_px REAL,
          leverage_type TEXT,
          leverage_value REAL,
          updated_at TEXT
        );
      `);
      legacyDb.run(
        `INSERT INTO hedge_events
         (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          "ETH",
          "open",
          2000,
          0.5,
          "2024-01-02T00:00:00Z",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      );

      initSchema(legacyDb);

      const migrated = legacyDb
        .query<Pick<StoredHedgeEvent, "token_id" | "coin" | "trade_key" | "tax_key">, []>(
          "SELECT token_id, coin, trade_key, tax_key FROM hedge_events WHERE id = 1",
        )
        .get();
      const tradeIndex = legacyDb
        .query<{ name: string; unique: number }, []>("PRAGMA index_list('hedge_events')")
        .all()
        .find((index) => index.name === "idx_hedge_events_trade_key");

      expect(migrated).toEqual({
        token_id: null,
        coin: "ETH",
        trade_key: "trade:legacy:unassigned:ETH:2024-01-02T00:00:00Z:2000:0.5:row:1",
        tax_key: "tax:legacy:unassigned:ETH:2024-01-02T00:00:00Z:2000:0.5:row:1",
      });
      expect(tradeIndex?.unique).toBe(1);
    });

    it("creates trade_key unique index on current-schema databases without one", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT,
          current_szi TEXT,
          mark_px REAL,
          unrealized_pnl REAL,
          liquidation_px REAL,
          leverage_type TEXT,
          leverage_value REAL,
          updated_at TEXT
        );
      `);

      initSchema(legacyDb);

      const tradeIndex = legacyDb
        .query<{ name: string; unique: number }, []>("PRAGMA index_list('hedge_events')")
        .all()
        .find((index) => index.name === "idx_hedge_events_trade_key");
      expect(tradeIndex?.unique).toBe(1);
    });

    it("rewrites duplicate non-null legacy no-fill trade keys before creating the unique index", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT,
          current_szi TEXT,
          mark_px REAL,
          unrealized_pnl REAL,
          liquidation_px REAL,
          leverage_type TEXT,
          leverage_value REAL,
          updated_at TEXT
        );
      `);

      for (let index = 0; index < 2; index += 1) {
        legacyDb.run(
          `INSERT INTO hedge_events
           (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            null,
            "HYPE",
            "closed",
            100,
            1.5,
            "2024-01-01T00:00:00Z",
            "2024-01-01T12:00:00Z",
            99,
            -1.5,
            0,
            "manual",
            null,
            "trade:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5",
            index === 0 ? "tax:manual:preserve-me" : null,
          ],
        );
      }

      expect(() => initSchema(legacyDb)).not.toThrow();

      const migratedRows = legacyDb
        .query<Pick<StoredHedgeEvent, "id" | "trade_key" | "tax_key">, []>(
          "SELECT id, trade_key, tax_key FROM hedge_events ORDER BY id ASC",
        )
        .all();

      expect(migratedRows).toHaveLength(2);
      expect(migratedRows[0]?.trade_key).toBe(
        "trade:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:1",
      );
      expect(migratedRows[1]?.trade_key).toBe(
        "trade:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:2",
      );
      expect(migratedRows[0]?.tax_key).toBe("tax:manual:preserve-me");
      expect(migratedRows[1]?.tax_key).toBe(
        "tax:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:2",
      );

      const distinctTradeKeyCount = legacyDb
        .query<{ count: number }, []>("SELECT COUNT(DISTINCT trade_key) AS count FROM hedge_events")
        .get();
      expect(distinctTradeKeyCount?.count).toBe(2);

      const tradeIndex = legacyDb
        .query<{ name: string; unique: number }, []>("PRAGMA index_list('hedge_events')")
        .all()
        .find((index) => index.name === "idx_hedge_events_trade_key");
      expect(tradeIndex?.unique).toBe(1);
    });

    it("preserves unique current no-fill trade keys across repeated initSchema runs", () => {
      const legacyDb = new Database(":memory:");
      legacyDb.exec(`
        CREATE TABLE hedge_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id TEXT,
          coin TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          entry_px REAL NOT NULL,
          size REAL NOT NULL,
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          close_px REAL,
          realized_pnl REAL,
          funding_earned REAL,
          close_reason TEXT,
          hl_fill_hash TEXT UNIQUE,
          trade_key TEXT,
          tax_key TEXT,
          current_szi TEXT,
          mark_px REAL,
          unrealized_pnl REAL,
          liquidation_px REAL,
          leverage_type TEXT,
          leverage_value REAL,
          updated_at TEXT
        );
      `);

      legacyDb.run(
        `INSERT INTO hedge_events
         (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          "HYPE",
          "closed",
          100,
          1.5,
          "2024-01-01T00:00:00Z",
          "2024-01-01T12:00:00Z",
          99,
          -1.5,
          0,
          "manual",
          null,
          "trade:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5",
          null,
        ],
      );

      initSchema(legacyDb);
      initSchema(legacyDb);

      const migrated = legacyDb
        .query<Pick<StoredHedgeEvent, "trade_key" | "tax_key">, []>(
          "SELECT trade_key, tax_key FROM hedge_events WHERE id = 1",
        )
        .get();
      expect(migrated?.trade_key).toBe("trade:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5");
      expect(migrated?.tax_key).toBe(
        "tax:legacy:unassigned:HYPE:2024-01-01T00:00:00Z:100:1.5:row:1",
      );

      const tradeIndex = legacyDb
        .query<{ name: string; unique: number }, []>("PRAGMA index_list('hedge_events')")
        .all()
        .find((index) => index.name === "idx_hedge_events_trade_key");
      expect(tradeIndex?.unique).toBe(1);
    });

    it("deduplicates closed hedge lifecycle rows while preserving the earliest assigned row", () => {
      const legacyDb = new Database(":memory:");
      initSchema(legacyDb);

      const insertDuplicate = legacyDb.query(
        `INSERT INTO hedge_events
         (token_id, coin, status, entry_px, size, opened_at, closed_at, close_px, realized_pnl, funding_earned, close_reason, hl_fill_hash, trade_key, tax_key)
         VALUES (?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, 'manual_close', ?, ?, ?)`,
      );

      insertDuplicate.run(
        "484645",
        "HYPE",
        58.37,
        30.1,
        "2026-06-11T18:43:20.016Z",
        "2026-06-12T17:09:46.918Z",
        61.6444631229236,
        -98.56134,
        null,
        "legacy-fill",
        "trade:fill:HYPE:legacy-fill",
        "tax:legacy:484645:HYPE:legacy-fill",
      );
      insertDuplicate.run(
        "484645",
        "HYPE",
        58.37,
        30.1,
        "2026-06-11T18:43:20.016Z",
        "2026-06-12T17:09:46.918Z",
        61.6444631229236,
        -98.56134,
        null,
        "discovery-fill",
        "trade:fill:HYPE:discovery-fill",
        "tax:fill:HYPE:discovery-fill",
      );

      initSchema(legacyDb);

      const rows = legacyDb
        .query<Pick<StoredHedgeEvent, "id" | "token_id" | "hl_fill_hash" | "tax_key">, []>(
          "SELECT id, token_id, hl_fill_hash, tax_key FROM hedge_events ORDER BY id",
        )
        .all();
      expect(rows).toEqual([
        {
          id: 1,
          token_id: "484645",
          hl_fill_hash: "legacy-fill",
          tax_key: "tax:legacy:484645:HYPE:legacy-fill",
        },
      ]);
    });
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
