import { describe, it, expect } from "bun:test";

import {
  listCachedPositionViews,
  listCachedPnLViews,
  getPositionsCacheSyncedAt,
  replaceCachedPositionViews,
  replaceCachedPnLViews,
  getLpSyncState,
  upsertLpSyncState,
} from "../db/store.js";
import { isRecord } from "../utils/guards.js";
import { useTestDb } from "./helpers/db.js";

const fakeSyncedAt = "2026-06-01T20:00:00.000Z";

const fakePositionView = {
  tokenId: "12345",
  token0: { address: "0xabc", symbol: "WHYPE", decimals: 18 },
  token1: { address: "0xdef", symbol: "USDC", decimals: 6 },
  fee: 3000,
  feePercent: 0.3,
  tickLower: -100,
  tickUpper: 100,
  priceLower: 1.0,
  priceUpper: 2.0,
  currentPrice: 1.5,
  liquidity: "1000000000",
  status: "active",
  inRange: true,
  currentAmount0: 5.0,
  currentAmount1: 7.5,
};

const fakePnLView = {
  tokenId: "12345",
  pair: "WHYPE/USDC",
  token0Symbol: "WHYPE",
  token1Symbol: "USDC",
  status: "active",
  entryPrice: 1.0,
  exitPrice: 1.5,
  priceChangePercent: 0.5,
  entryAmount0: 10.0,
  entryAmount1: 10.0,
  exitAmount0: 8.0,
  exitAmount1: 11.0,
  feesCollected0: 0.1,
  feesCollected1: 0.05,
  feesCollected0Usd: null,
  feesCollected1Usd: null,
  feesValueUsd: null,
  token0UsdPrice: null,
  token1UsdPrice: null,
  usdPriceSource: null,
  feesValueInToken1: 0.15,
  entryValueInToken1: 20.0,
  exitValueInToken1: 23.0,
  holdValueInToken1: 22.0,
  absolutePnlInToken1: 3.0,
  absolutePnlPercent: 0.15,
  divergenceLossPercent: -0.01,
  opportunityCostInToken1: 0.2,
  netVsHodlPercent: 0.05,
  priceLower: 0.8,
  priceUpper: 2.0,
};

function readStringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function readNullableField(row: Record<string, unknown>, key: string): unknown {
  if (!(key in row)) {
    throw new Error(`Missing field ${key}`);
  }
  return row[key];
}

function requireCachedRow(row: unknown): Record<string, unknown> {
  if (!isRecord(row)) {
    throw new Error("Expected cached row to be an object");
  }
  readStringField(row, "tokenId");
  return row;
}

describe("lp cache store", () => {
  useTestDb();

  describe("empty DB behavior", () => {
    it("listCachedPositionViews returns [] on fresh DB without throwing", () => {
      expect(listCachedPositionViews()).toEqual([]);
    });

    it("listCachedPnLViews returns [] on fresh DB without throwing", () => {
      expect(listCachedPnLViews()).toEqual([]);
    });

    it("getPositionsCacheSyncedAt returns null on fresh DB", () => {
      expect(getPositionsCacheSyncedAt()).toBeNull();
    });

    it("getLpSyncState returns null when no state exists for wallet", () => {
      expect(getLpSyncState("0xwallet")).toBeNull();
    });
  });

  describe("empty-array replace clears the cache", () => {
    it("replaceCachedPositionViews([]) clears previously stored rows", () => {
      replaceCachedPositionViews([fakePositionView], fakeSyncedAt);
      expect(listCachedPositionViews()).toHaveLength(1);

      replaceCachedPositionViews([], fakeSyncedAt);
      expect(listCachedPositionViews()).toEqual([]);
    });

    it("replaceCachedPnLViews([]) clears previously stored rows", () => {
      replaceCachedPnLViews([fakePnLView], fakeSyncedAt);
      expect(listCachedPnLViews()).toHaveLength(1);

      replaceCachedPnLViews([], fakeSyncedAt);
      expect(listCachedPnLViews()).toEqual([]);
    });
  });

  describe("JSON round-trip preserves types", () => {
    it("position view round-trips numbers, strings, booleans, nested objects", () => {
      replaceCachedPositionViews([fakePositionView], fakeSyncedAt);
      const results = listCachedPositionViews();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(fakePositionView);
    });

    it("pnl view round-trips with null USD fields preserved as null (not undefined or string)", () => {
      replaceCachedPnLViews([fakePnLView], fakeSyncedAt);
      const results = listCachedPnLViews();
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(fakePnLView);
      const row = requireCachedRow(results[0]);
      // explicitly assert null fields stayed null
      expect(readNullableField(row, "feesCollected0Usd")).toBeNull();
      expect(readNullableField(row, "feesValueUsd")).toBeNull();
      expect(readNullableField(row, "usdPriceSource")).toBeNull();
    });

    it("getPositionsCacheSyncedAt returns the syncedAt timestamp after replace", () => {
      replaceCachedPositionViews([fakePositionView], fakeSyncedAt);
      expect(getPositionsCacheSyncedAt()).toBe(fakeSyncedAt);
    });
  });

  describe("replace is idempotent — second replace overwrites first", () => {
    it("second replaceCachedPositionViews call replaces all rows from first call", () => {
      const row1 = { ...fakePositionView, tokenId: "11111" };
      const row2 = { ...fakePositionView, tokenId: "22222" };

      replaceCachedPositionViews([row1], fakeSyncedAt);
      expect(listCachedPositionViews()).toHaveLength(1);

      replaceCachedPositionViews([row2], fakeSyncedAt);
      const results = listCachedPositionViews();
      expect(results).toHaveLength(1);
      expect(readStringField(requireCachedRow(results[0]), "tokenId")).toBe("22222");
    });

    it("second replaceCachedPnLViews call replaces all rows from first call", () => {
      const row1 = { ...fakePnLView, tokenId: "11111" };
      const row2 = { ...fakePnLView, tokenId: "22222" };

      replaceCachedPnLViews([row1], fakeSyncedAt);
      replaceCachedPnLViews([row2], fakeSyncedAt);

      const results = listCachedPnLViews();
      expect(results).toHaveLength(1);
      expect(readStringField(requireCachedRow(results[0]), "tokenId")).toBe("22222");
    });
  });

  describe("atomicity — failed replace leaves cache unchanged", () => {
    it("replaceCachedPositionViews rolls back on PRIMARY KEY conflict — cache retains previous state", () => {
      const original = { ...fakePositionView, tokenId: "original" };
      replaceCachedPositionViews([original], fakeSyncedAt);
      expect(listCachedPositionViews()).toHaveLength(1);

      const dup1 = { ...fakePositionView, tokenId: "duplicate" };
      const dup2 = { ...fakePositionView, tokenId: "duplicate" };

      expect(() => {
        replaceCachedPositionViews([dup1, dup2], fakeSyncedAt);
      }).toThrow();

      const after = listCachedPositionViews();
      expect(after).toHaveLength(1);
      expect(readStringField(requireCachedRow(after[0]), "tokenId")).toBe("original");
    });

    it("replaceCachedPnLViews rolls back on PRIMARY KEY conflict — cache retains previous state", () => {
      const original = { ...fakePnLView, tokenId: "original" };
      replaceCachedPnLViews([original], fakeSyncedAt);
      expect(listCachedPnLViews()).toHaveLength(1);

      const dup1 = { ...fakePnLView, tokenId: "duplicate" };
      const dup2 = { ...fakePnLView, tokenId: "duplicate" };

      expect(() => {
        replaceCachedPnLViews([dup1, dup2], fakeSyncedAt);
      }).toThrow();

      const after = listCachedPnLViews();
      expect(after).toHaveLength(1);
      expect(readStringField(requireCachedRow(after[0]), "tokenId")).toBe("original");
    });
  });

  describe("upsertLpSyncState insert and update", () => {
    it("inserts a new sync state that getLpSyncState returns", () => {
      upsertLpSyncState({ wallet: "0xwallet", last_synced_at: "2026-06-01T10:00:00.000Z" });
      expect(getLpSyncState("0xwallet")).toEqual({
        wallet: "0xwallet",
        last_synced_at: "2026-06-01T10:00:00.000Z",
      });
    });

    it("updates an existing sync state on conflict", () => {
      upsertLpSyncState({ wallet: "0xwallet", last_synced_at: "2026-06-01T10:00:00.000Z" });
      upsertLpSyncState({ wallet: "0xwallet", last_synced_at: "2026-06-01T12:00:00.000Z" });
      expect(getLpSyncState("0xwallet")).toEqual({
        wallet: "0xwallet",
        last_synced_at: "2026-06-01T12:00:00.000Z",
      });
    });

    it("does not affect a different wallet's sync state", () => {
      upsertLpSyncState({ wallet: "0xwallet1", last_synced_at: "2026-06-01T10:00:00.000Z" });
      expect(getLpSyncState("0xwallet2")).toBeNull();
    });
  });
});
