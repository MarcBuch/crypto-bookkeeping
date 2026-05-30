import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import { getDb, resetDb } from "../db/schema.js";
import {
  getTaxSyncState,
  getTaxTransaction,
  listTaxTransactions,
  type SyncedTaxTransaction,
  upsertSyncedTaxTransaction,
  upsertTaxSyncState,
  updateTaxTransaction,
} from "../db/store.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-tax-tests";

function makeSyncedTaxTransaction(
  overrides: Partial<SyncedTaxTransaction> = {},
): SyncedTaxTransaction {
  return {
    id: "tx-1:external",
    hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    block_number: 100,
    time_stamp: "2026-05-30T12:00:00.000Z",
    from_address: "0xfrom",
    to_address: "0xto",
    value: "1000000000000000000",
    gas_used: "21000",
    gas_price: "1000000000",
    fee: "21000000000000",
    method_id: "0x12345678",
    function_name: "transfer(address,uint256)",
    input: "0xabcdef",
    contract_address: null,
    token_symbol: null,
    token_decimal: null,
    token_name: null,
    transaction_type: "txlist",
    source: "hyperevmscan",
    is_error: 0,
    synced_at: "2026-05-30T12:01:00.000Z",
    ...overrides,
  };
}

describe("tax transaction persistence", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    process.env.LP_TRACKER_DATA_DIR = join(TMP, crypto.randomUUID());
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("upserts the same id by updating synced fields while preserving label and comment", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());
    expect(
      updateTaxTransaction("tx-1:external", { label: "Trade", comment: "manual note" }),
    ).toMatchObject({
      label: "Trade",
      comment: "manual note",
    });

    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "tx-1:external",
        hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
        block_number: 101,
        value: "2000000000000000000",
        fee: "42000000000000",
        function_name: "approve(address,uint256)",
        synced_at: "2026-05-30T12:05:00.000Z",
      }),
    );

    expect(getTaxTransaction("tx-1:external")).toMatchObject({
      id: "tx-1:external",
      hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      block_number: 101,
      value: "2000000000000000000",
      fee: "42000000000000",
      function_name: "approve(address,uint256)",
      synced_at: "2026-05-30T12:05:00.000Z",
      label: "Trade",
      comment: "manual note",
    });
  });

  it("allows multiple rows with the same hash when ids differ", () => {
    const hash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction({ id: "tx-1:external", hash }));
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "tx-1:internal-0",
        hash,
        transaction_type: "txlistinternal",
        value: "2",
      }),
    );

    const rows = listTaxTransactions();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set(["tx-1:external", "tx-1:internal-0"]),
    );
    expect(rows.every((row) => row.hash === hash)).toBe(true);
  });

  it("rejects invalid labels through store update and the database constraint", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(() => updateTaxTransaction("tx-1:external", { label: "Income" as never })).toThrow(
      "Tax transaction label",
    );

    const db = getDb();
    expect(() =>
      db.query("UPDATE tax_transactions SET label = ? WHERE id = ?").run("Income", "tx-1:external"),
    ).toThrow();
    expect(getTaxTransaction("tx-1:external")?.label).toBeNull();
  });

  it("accepts Trade, Transfer, and null labels", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(updateTaxTransaction("tx-1:external", { label: "Trade" })?.label).toBe("Trade");
    expect(updateTaxTransaction("tx-1:external", { label: "Transfer" })?.label).toBe("Transfer");
    expect(updateTaxTransaction("tx-1:external", { label: null })?.label).toBeNull();
  });

  it("stores empty comments as empty strings and clears null comments to null", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(updateTaxTransaction("tx-1:external", { comment: "" })?.comment).toBe("");
    expect(getTaxTransaction("tx-1:external")?.comment).toBe("");

    expect(updateTaxTransaction("tx-1:external", { comment: null })?.comment).toBeNull();
    expect(getTaxTransaction("tx-1:external")?.comment).toBeNull();
  });

  it("lists newest timestamp and highest block first while respecting limit and offset", () => {
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "old",
        block_number: 100,
        time_stamp: "2026-05-30T10:00:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "new-low-block",
        block_number: 101,
        time_stamp: "2026-05-30T11:00:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "new-high-block",
        block_number: 102,
        time_stamp: "2026-05-30T11:00:00.000Z",
      }),
    );

    expect(listTaxTransactions().map((row) => row.id)).toEqual([
      "new-high-block",
      "new-low-block",
      "old",
    ]);
    expect(listTaxTransactions(1, 1).map((row) => row.id)).toEqual(["new-low-block"]);
  });

  it("filters listed transactions by label before applying pagination", () => {
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "trade-newest",
        block_number: 106,
        time_stamp: "2026-05-30T12:06:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "transfer-newer",
        block_number: 105,
        time_stamp: "2026-05-30T12:05:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled-3",
        block_number: 104,
        time_stamp: "2026-05-30T12:04:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "trade-middle",
        block_number: 103,
        time_stamp: "2026-05-30T12:03:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled-2",
        block_number: 102,
        time_stamp: "2026-05-30T12:02:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "transfer-old",
        block_number: 101,
        time_stamp: "2026-05-30T12:01:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled-1",
        block_number: 100,
        time_stamp: "2026-05-30T12:00:00.000Z",
      }),
    );
    updateTaxTransaction("trade-newest", { label: "Trade" });
    updateTaxTransaction("transfer-newer", { label: "Transfer" });
    updateTaxTransaction("trade-middle", { label: "Trade" });
    updateTaxTransaction("transfer-old", { label: "Transfer" });

    expect(listTaxTransactions(50, 0).map((row) => row.id)).toEqual([
      "trade-newest",
      "transfer-newer",
      "unlabeled-3",
      "trade-middle",
      "unlabeled-2",
      "transfer-old",
      "unlabeled-1",
    ]);
    expect(listTaxTransactions(50, 0, "Trade").map((row) => row.id)).toEqual([
      "trade-newest",
      "trade-middle",
    ]);
    expect(listTaxTransactions(50, 0, "Transfer").map((row) => row.id)).toEqual([
      "transfer-newer",
      "transfer-old",
    ]);
    expect(listTaxTransactions(50, 0, "unlabeled").map((row) => row.id)).toEqual([
      "unlabeled-3",
      "unlabeled-2",
      "unlabeled-1",
    ]);
    expect(listTaxTransactions(2, 1, "unlabeled").map((row) => row.id)).toEqual([
      "unlabeled-2",
      "unlabeled-1",
    ]);
  });

  it("returns null when getting or updating an unknown id", () => {
    expect(getTaxTransaction("missing")).toBeNull();
    expect(updateTaxTransaction("missing", { label: "Trade", comment: "ignored" })).toBeNull();
  });

  it("upserts and reads tax sync state by wallet", () => {
    expect(getTaxSyncState("0xwallet")).toBeNull();

    upsertTaxSyncState({
      wallet: "0xwallet",
      last_synced_at: "2026-05-30T12:00:00.000Z",
      last_block_number: 100,
      source: "hyperevmscan",
    });
    upsertTaxSyncState({
      wallet: "0xwallet",
      last_synced_at: "2026-05-30T13:00:00.000Z",
      last_block_number: 200,
      source: "hyperevmscan-v2",
    });

    expect(getTaxSyncState("0xwallet")).toEqual({
      wallet: "0xwallet",
      last_synced_at: "2026-05-30T13:00:00.000Z",
      last_block_number: 200,
      source: "hyperevmscan-v2",
    });
  });
});
