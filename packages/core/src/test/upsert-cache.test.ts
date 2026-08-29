import { describe, it, expect } from "bun:test";

import {
  listCachedPositionViews,
  listCachedPnLViews,
  upsertPositionViewCache,
  upsertPnLViewCache,
} from "../db/store.js";
import { useTestDb } from "./helpers/db.js";

const validSyncedAt = "2026-06-01T20:00:00.000Z";

function getRowId(row: Record<string, unknown>): string {
  expect(typeof row.id).toBe("string");
  if (typeof row.id !== "string") {
    throw new Error(`Expected cached row id to be a string, got ${String(row.id)}`);
  }
  return row.id;
}

describe("upsertPositionViewCache — INSERT OR REPLACE behavior", () => {
  useTestDb();

  it("replaces existing row when same tokenId is upserted again", () => {
    const data1 = { value: "first" };
    const data2 = { value: "second" };

    upsertPositionViewCache("123", data1, validSyncedAt);
    expect(listCachedPositionViews()).toHaveLength(1);
    expect(listCachedPositionViews()[0]).toEqual(data1);

    upsertPositionViewCache("123", data2, validSyncedAt);
    const results = listCachedPositionViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data2);
  });
});

describe("upsertPnLViewCache — INSERT OR REPLACE behavior", () => {
  useTestDb();

  it("replaces existing row when same tokenId is upserted again", () => {
    const data1 = { value: "first" };
    const data2 = { value: "second" };

    upsertPnLViewCache("123", data1, validSyncedAt);
    expect(listCachedPnLViews()).toHaveLength(1);
    expect(listCachedPnLViews()[0]).toEqual(data1);

    upsertPnLViewCache("123", data2, validSyncedAt);
    const results = listCachedPnLViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data2);
  });
});

describe("upsertPositionViewCache — row isolation and idempotency", () => {
  useTestDb();

  it("row isolation: only target row modified when upserting", () => {
    // Pre-populate 3 rows
    const dataA = { id: "A", value: 1 };
    const dataB = { id: "B", value: 2 };
    const dataC = { id: "C", value: 3 };

    upsertPositionViewCache("A", dataA, validSyncedAt);
    upsertPositionViewCache("B", dataB, validSyncedAt);
    upsertPositionViewCache("C", dataC, validSyncedAt);

    expect(listCachedPositionViews()).toHaveLength(3);

    // Upsert only B with new data
    const newDataB = { id: "B", value: 22, updated: true };
    upsertPositionViewCache("B", newDataB, validSyncedAt);

    // Verify A and C are unchanged, B has new data
    const results = listCachedPositionViews();
    expect(results).toHaveLength(3);

    const resultsByValue = results.reduce((acc: Record<string, Record<string, unknown>>, row) => {
      acc[getRowId(row)] = row;
      return acc;
    }, {});

    expect(resultsByValue["A"]).toEqual(dataA);
    expect(resultsByValue["B"]).toEqual(newDataB);
    expect(resultsByValue["C"]).toEqual(dataC);
  });

  it("idempotent re-upsert with same data", () => {
    const data = { count: 1, name: "test" };

    upsertPositionViewCache("42", data, validSyncedAt);
    expect(listCachedPositionViews()).toHaveLength(1);

    // Re-upsert with identical data
    upsertPositionViewCache("42", data, validSyncedAt);
    expect(listCachedPositionViews()).toHaveLength(1);
    expect(listCachedPositionViews()[0]).toEqual(data);
  });

  it("idempotent re-upsert with updated data", () => {
    const data1 = { version: 1 };
    const data2 = { version: 2, extra: "field" };

    upsertPositionViewCache("42", data1, validSyncedAt);
    expect(listCachedPositionViews()).toHaveLength(1);
    expect(listCachedPositionViews()[0]).toEqual(data1);

    // Upsert again with different data
    upsertPositionViewCache("42", data2, validSyncedAt);

    // Verify only 1 row exists and it has the second upsert's data
    const results = listCachedPositionViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data2);
  });

  it("first insert for never-seen tokenId", () => {
    // Start with empty DB
    expect(listCachedPositionViews()).toHaveLength(0);

    const data = { id: "99", newToken: true };
    upsertPositionViewCache("99", data, validSyncedAt);

    // Verify exactly 1 row is created with correct data
    const results = listCachedPositionViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data);
  });
});

describe("upsertPnLViewCache — row isolation and idempotency", () => {
  useTestDb();

  it("row isolation: only target row modified when upserting", () => {
    // Pre-populate 3 rows
    const dataA = { id: "A", value: 1 };
    const dataB = { id: "B", value: 2 };
    const dataC = { id: "C", value: 3 };

    upsertPnLViewCache("A", dataA, validSyncedAt);
    upsertPnLViewCache("B", dataB, validSyncedAt);
    upsertPnLViewCache("C", dataC, validSyncedAt);

    expect(listCachedPnLViews()).toHaveLength(3);

    // Upsert only B with new data
    const newDataB = { id: "B", value: 22, updated: true };
    upsertPnLViewCache("B", newDataB, validSyncedAt);

    // Verify A and C are unchanged, B has new data
    const results = listCachedPnLViews();
    expect(results).toHaveLength(3);

    const resultsByValue = results.reduce((acc: Record<string, Record<string, unknown>>, row) => {
      acc[getRowId(row)] = row;
      return acc;
    }, {});

    expect(resultsByValue["A"]).toEqual(dataA);
    expect(resultsByValue["B"]).toEqual(newDataB);
    expect(resultsByValue["C"]).toEqual(dataC);
  });

  it("idempotent re-upsert with same data", () => {
    const data = { count: 1, name: "test" };

    upsertPnLViewCache("42", data, validSyncedAt);
    expect(listCachedPnLViews()).toHaveLength(1);

    // Re-upsert with identical data
    upsertPnLViewCache("42", data, validSyncedAt);
    expect(listCachedPnLViews()).toHaveLength(1);
    expect(listCachedPnLViews()[0]).toEqual(data);
  });

  it("idempotent re-upsert with updated data", () => {
    const data1 = { version: 1 };
    const data2 = { version: 2, extra: "field" };

    upsertPnLViewCache("42", data1, validSyncedAt);
    expect(listCachedPnLViews()).toHaveLength(1);
    expect(listCachedPnLViews()[0]).toEqual(data1);

    // Upsert again with different data
    upsertPnLViewCache("42", data2, validSyncedAt);

    // Verify only 1 row exists and it has the second upsert's data
    const results = listCachedPnLViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data2);
  });

  it("first insert for never-seen tokenId", () => {
    // Start with empty DB
    expect(listCachedPnLViews()).toHaveLength(0);

    const data = { id: "99", newToken: true };
    upsertPnLViewCache("99", data, validSyncedAt);

    // Verify exactly 1 row is created with correct data
    const results = listCachedPnLViews();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(data);
  });
});
