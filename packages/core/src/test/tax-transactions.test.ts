import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";

import { getDb, resolveDbPath } from "../db/schema.js";
import {
  createManualTaxTransaction,
  countTaxTransactions,
  getTaxTransactionsNeedingGermanTaxReview,
  listGermanTaxableTransactions,
  getTaxSyncState,
  getTaxTransaction,
  listTaxTransactions,
  type ManualTaxTransactionInput,
  type SyncedTaxTransaction,
  upsertSyncedTaxTransaction,
  upsertTaxSyncState,
  updateTaxTransaction,
} from "../db/store.js";
import { sqliteTaxLedgerStore } from "../db/tax-ledger-store.js";
import { useTestDb } from "./helpers/db.js";

type TableSqlRow = { sql: string };

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
    incoming_quantity: null,
    incoming_asset: null,
    outgoing_quantity: null,
    outgoing_asset: null,
    cost_eur: null,
    proceeds_eur: null,
    gain_eur: null,
    holding_duration_days: null,
    synced_at: "2026-05-30T12:01:00.000Z",
    ...overrides,
  };
}

function makeManualTaxTransaction(
  overrides: ManualTaxTransactionInput = {},
): ManualTaxTransactionInput {
  return {
    time_stamp: "2026-05-30T12:00:00.000Z",
    label: "Trade",
    incoming_quantity: "1.5",
    incoming_asset: "HYPE",
    outgoing_quantity: "42.00",
    outgoing_asset: "USDC",
    cost_eur: "40.00",
    proceeds_eur: "45.00",
    gain_eur: "5.00",
    holding_duration_days: 7,
    comment: "manual ledger entry",
    ...overrides,
  };
}

describe("tax transaction persistence", () => {
  useTestDb();

  describe("TaxLedgerStore invariants", () => {
    it("preserves manual label/comment across synced upserts through the scoped store", () => {
      sqliteTaxLedgerStore.upsertSyncedTransaction(makeSyncedTaxTransaction());

      expect(
        sqliteTaxLedgerStore.updateTransaction("tx-1:external", {
          label: "Trade",
          comment: "manual note",
        }),
      ).toMatchObject({
        label: "Trade",
        comment: "manual note",
      });

      sqliteTaxLedgerStore.upsertSyncedTransaction(
        makeSyncedTaxTransaction({
          hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          block_number: 101,
          value: "2",
          synced_at: "2026-05-30T12:05:00.000Z",
        }),
      );

      expect(sqliteTaxLedgerStore.getTransaction("tx-1:external")).toMatchObject({
        hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        block_number: 101,
        value: "2",
        label: "Trade",
        comment: "manual note",
      });
    });

    it("does not let synced-only upserts overwrite manual rows", () => {
      const created = sqliteTaxLedgerStore.createManualTransaction(
        makeManualTaxTransaction({
          id: "scoped-manual-row",
          hash: "manual-hash",
          label: "Transfer",
          incoming_quantity: "9",
          incoming_asset: "USDC",
          comment: "keep me manual",
        }),
      );

      sqliteTaxLedgerStore.upsertSyncedTransaction(
        makeSyncedTaxTransaction({
          id: created.id,
          hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          transaction_type: "tokentx",
          source: "hyperevmscan",
          incoming_quantity: "1",
          incoming_asset: "HYPE",
          synced_at: "2026-05-30T12:10:00.000Z",
        }),
      );

      expect(sqliteTaxLedgerStore.getTransaction(created.id)).toMatchObject({
        id: created.id,
        source: "manual",
        transaction_type: "manual",
        hash: "manual-hash",
        label: "Transfer",
        incoming_quantity: "9",
        incoming_asset: "USDC",
        comment: "keep me manual",
      });
    });

    it("only allows manual rows to update ledger properties through the scoped store", () => {
      sqliteTaxLedgerStore.upsertSyncedTransaction(makeSyncedTaxTransaction());

      expect(() =>
        sqliteTaxLedgerStore.updateTransaction("tx-1:external", { incoming_quantity: "1" }),
      ).toThrow("Only manual tax transactions can update ledger properties");
    });
  });

  it("upserts the same id by updating synced fields while preserving manual metadata", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());
    expect(
      updateTaxTransaction("tx-1:external", { label: "Trade", comment: "manual note" }),
    ).toMatchObject({
      label: "Trade",
      comment: "manual note",
    });
    getDb()
      .query(
        `UPDATE tax_transactions
         SET cost_eur = ?, proceeds_eur = ?, gain_eur = ?, holding_duration_days = ?
         WHERE id = ?`,
      )
      .run("100.00", "125.00", "25.00", 30, "tx-1:external");

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
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      cost_eur: "100.00",
      proceeds_eur: "125.00",
      gain_eur: "25.00",
      holding_duration_days: 30,
    });
  });

  it("creates nullable tax ledger fields for synced transactions", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(getTaxTransaction("tx-1:external")).toMatchObject({
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      cost_eur: null,
      proceeds_eur: null,
      gain_eur: null,
      holding_duration_days: null,
    });
  });

  it("creates a valid minimal manual transaction with generated id and ledger fields", () => {
    const created = createManualTaxTransaction(makeManualTaxTransaction());
    const createdId = created.id;

    expect(created).toMatchObject({
      id: expect.stringMatching(/^manual:auto:[a-f0-9]{24}$/),
      hash: createdId,
      block_number: null,
      time_stamp: "2026-05-30T12:00:00.000Z",
      from_address: null,
      to_address: null,
      value: null,
      gas_used: null,
      gas_price: null,
      fee: null,
      method_id: null,
      function_name: null,
      input: null,
      contract_address: null,
      token_symbol: null,
      token_decimal: null,
      token_name: null,
      transaction_type: "manual",
      source: "manual",
      is_error: null,
      label: "Trade",
      incoming_quantity: "1.5",
      incoming_asset: "HYPE",
      outgoing_quantity: "42.00",
      outgoing_asset: "USDC",
      cost_eur: "40.00",
      proceeds_eur: "45.00",
      gain_eur: "5.00",
      holding_duration_days: 7,
      comment: "manual ledger entry",
    });
    expect(created.synced_at).toBeString();
    expect(created.created_at).toBeString();
    expect(created.updated_at).toBeString();
    expect(getTaxTransaction(createdId)).toEqual(created);
  });

  it("suffixes duplicate generated manual ids while avoiding existing collisions", () => {
    const input = makeManualTaxTransaction({ comment: "same generated identity" });
    const first = createManualTaxTransaction(input);
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: `${first.id}-2`,
        hash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      }),
    );

    const second = createManualTaxTransaction(input);

    expect(second.id).toBe(`${first.id}-3`);
    expect(getTaxTransaction(first.id)).toMatchObject({ source: "manual" });
    expect(getTaxTransaction(`${first.id}-2`)).toMatchObject({ source: "hyperevmscan" });
    expect(getTaxTransaction(second.id)).toMatchObject({ source: "manual" });
  });

  it("rejects duplicate explicit manual ids", () => {
    createManualTaxTransaction(makeManualTaxTransaction({ id: "tax-lot-1" }));

    expect(() =>
      createManualTaxTransaction(makeManualTaxTransaction({ id: "manual:tax-lot-1" })),
    ).toThrow("Manual tax transaction already exists: manual:tax-lot-1");
  });

  it("namespaces and sanitizes explicit manual ids with case-insensitive manual prefix", () => {
    const created = createManualTaxTransaction(
      makeManualTaxTransaction({ id: "  Manual:My Tax Lot #1  " }),
    );

    expect(created.id).toBe("manual:my-tax-lot-1");
    expect(
      createManualTaxTransaction(makeManualTaxTransaction({ id: "MANUAL:Second Lot" })).id,
    ).toBe("manual:second-lot");
    expect(() => createManualTaxTransaction(makeManualTaxTransaction({ id: " -- !! " }))).toThrow(
      "Manual tax transaction id must contain at least one safe character",
    );
  });

  it("rejects empty explicit manual ids without inserting a row", () => {
    expect(() => createManualTaxTransaction(makeManualTaxTransaction({ id: "" }))).toThrow(
      "Manual tax transaction id must contain at least one safe character",
    );

    expect(listTaxTransactions()).toHaveLength(0);
  });

  it("rejects invalid labels during manual creation", () => {
    expect(() =>
      createManualTaxTransaction(
        // @ts-expect-error Intentionally invalid label to verify runtime validation.
        makeManualTaxTransaction({ label: "Income" }),
      ),
    ).toThrow("Tax transaction label");

    expect(listTaxTransactions()).toHaveLength(0);
  });

  it("keeps synced upsert behavior unchanged and prevents manual creation from overwriting synced rows", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction({ id: "manual:reserved" }));
    updateTaxTransaction("manual:reserved", { label: "Transfer", comment: "synced note" });

    expect(() =>
      createManualTaxTransaction(
        makeManualTaxTransaction({ id: "Manual:Reserved", label: "Trade" }),
      ),
    ).toThrow("Manual tax transaction already exists: manual:reserved");
    expect(getTaxTransaction("manual:reserved")).toMatchObject({
      source: "hyperevmscan",
      label: "Transfer",
      comment: "synced note",
    });

    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "manual:reserved",
        hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        value: "3",
      }),
    );
    expect(getTaxTransaction("manual:reserved")).toMatchObject({
      source: "hyperevmscan",
      hash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      value: "3",
      label: "Transfer",
      comment: "synced note",
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

    expect(() =>
      // @ts-expect-error Intentionally invalid label to verify runtime validation.
      updateTaxTransaction("tx-1:external", { label: "Income" }),
    ).toThrow("Tax transaction label");

    const db = getDb();
    expect(() =>
      db.query("UPDATE tax_transactions SET label = ? WHERE id = ?").run("Income", "tx-1:external"),
    ).toThrow();
    expect(getTaxTransaction("tx-1:external")?.label).toBeNull();
  });

  it("accepts Trade, Transfer, Approval, and null labels", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(updateTaxTransaction("tx-1:external", { label: "Trade" })?.label).toBe("Trade");
    expect(updateTaxTransaction("tx-1:external", { label: "Transfer" })?.label).toBe("Transfer");
    expect(updateTaxTransaction("tx-1:external", { label: "Approval" })?.label).toBe("Approval");
    expect(updateTaxTransaction("tx-1:external", { label: null })?.label).toBeNull();
  });

  it("migrates legacy label constraint and allows Approval labels", () => {
    const dbPath = resolveDbPath();
    const legacyDb = new Database(dbPath, { create: true });
    legacyDb.exec(`
      CREATE TABLE tax_transactions (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        block_number INTEGER,
        time_stamp TEXT,
        from_address TEXT,
        to_address TEXT,
        value TEXT,
        gas_used TEXT,
        gas_price TEXT,
        fee TEXT,
        method_id TEXT,
        function_name TEXT,
        input TEXT,
        contract_address TEXT,
        token_symbol TEXT,
        token_decimal INTEGER,
        token_name TEXT,
        transaction_type TEXT,
        source TEXT NOT NULL,
        is_error INTEGER,
        label TEXT CHECK (label IS NULL OR label IN ('Trade', 'Transfer')),
        incoming_quantity TEXT,
        incoming_asset TEXT,
        outgoing_quantity TEXT,
        outgoing_asset TEXT,
        cost_eur TEXT,
        proceeds_eur TEXT,
        gain_eur TEXT,
        holding_duration_days INTEGER,
        comment TEXT,
        synced_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      INSERT INTO tax_transactions (id, hash, source, transaction_type, synced_at, label)
      VALUES ('legacy-row', '0xlegacy', 'manual', 'manual', datetime('now'), 'Trade');
    `);
    legacyDb.close();

    const migratedDb = getDb();
    const tableSql = migratedDb
      .query<TableSqlRow, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tax_transactions'",
      )
      .get();

    expect(tableSql?.sql).toContain("Approval");
    expect(updateTaxTransaction("legacy-row", { label: "Approval" })?.label).toBe("Approval");
    expect(getTaxTransaction("legacy-row")?.label).toBe("Approval");
  });

  it("stores empty comments as empty strings and clears null comments to null", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(updateTaxTransaction("tx-1:external", { comment: "" })?.comment).toBe("");
    expect(getTaxTransaction("tx-1:external")?.comment).toBe("");

    expect(updateTaxTransaction("tx-1:external", { comment: null })?.comment).toBeNull();
    expect(getTaxTransaction("tx-1:external")?.comment).toBeNull();
  });

  it("updates all editable properties for manual tax transactions", () => {
    const transaction = createManualTaxTransaction(
      makeManualTaxTransaction({
        id: "editable",
        hash: "manual-edit-original",
        incoming_quantity: "1",
        incoming_asset: "HYPE",
      }),
    );

    const updated = updateTaxTransaction(transaction.id, {
      hash: "manual-edit-updated",
      block_number: 42,
      time_stamp: "2026-05-31T12:00:00.000Z",
      from_address: "0xfrom",
      to_address: "0xto",
      value: "1000000000000000000",
      gas_used: "21000",
      gas_price: "1000",
      fee: "21000000",
      method_id: "0xabcdef12",
      function_name: "manual()",
      input: "0xabcdef12",
      contract_address: "0xcontract",
      token_symbol: "HYPE",
      token_decimal: 18,
      token_name: "Hyperliquid",
      is_error: 0,
      label: "Trade",
      incoming_quantity: "2",
      incoming_asset: "WHYPE",
      outgoing_quantity: "3",
      outgoing_asset: "USDC",
      cost_eur: "10.00",
      proceeds_eur: "12.00",
      gain_eur: "2.00",
      holding_duration_days: 7,
      comment: "edited",
    });

    expect(updated).toMatchObject({
      id: transaction.id,
      source: "manual",
      transaction_type: "manual",
      hash: "manual-edit-updated",
      block_number: 42,
      time_stamp: "2026-05-31T12:00:00.000Z",
      from_address: "0xfrom",
      to_address: "0xto",
      value: "1000000000000000000",
      gas_used: "21000",
      gas_price: "1000",
      fee: "21000000",
      method_id: "0xabcdef12",
      function_name: "manual()",
      input: "0xabcdef12",
      contract_address: "0xcontract",
      token_symbol: "HYPE",
      token_decimal: 18,
      token_name: "Hyperliquid",
      is_error: 0,
      label: "Trade",
      incoming_quantity: "2",
      incoming_asset: "WHYPE",
      outgoing_quantity: "3",
      outgoing_asset: "USDC",
      cost_eur: "10.00",
      proceeds_eur: "12.00",
      gain_eur: "2.00",
      holding_duration_days: 7,
      comment: "edited",
    });
  });

  it("rejects ledger-property updates for synced tax transactions", () => {
    upsertSyncedTaxTransaction(makeSyncedTaxTransaction());

    expect(() => updateTaxTransaction("tx-1:external", { incoming_quantity: "1" })).toThrow(
      "Only manual tax transactions can update ledger properties",
    );
    expect(getTaxTransaction("tx-1:external")).toMatchObject({
      source: "hyperevmscan",
      incoming_quantity: null,
    });
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
    updateTaxTransaction("unlabeled-2", { label: "Approval" });

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
    expect(listTaxTransactions(50, 0, "Approval").map((row) => row.id)).toEqual(["unlabeled-2"]);
    expect(listTaxTransactions(50, 0, "unlabeled").map((row) => row.id)).toEqual([
      "unlabeled-3",
      "unlabeled-1",
    ]);
    expect(listTaxTransactions(2, 1, "unlabeled").map((row) => row.id)).toEqual(["unlabeled-1"]);
    expect(countTaxTransactions()).toBe(7);
    expect(countTaxTransactions("Trade")).toBe(2);
    expect(countTaxTransactions("Transfer")).toBe(2);
    expect(countTaxTransactions("Approval")).toBe(1);
    expect(countTaxTransactions("unlabeled")).toBe(2);
  });

  it("returns null when getting or updating an unknown id", () => {
    expect(getTaxTransaction("missing")).toBeNull();
    expect(updateTaxTransaction("missing", { label: "Trade", comment: "ignored" })).toBeNull();
  });

  it("lists German-taxable rows by excluding Approval labels", () => {
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "approval",
        block_number: 103,
        time_stamp: "2026-05-30T12:03:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "trade",
        block_number: 102,
        time_stamp: "2026-05-30T12:02:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "transfer",
        block_number: 101,
        time_stamp: "2026-05-30T12:01:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled",
        block_number: 100,
        time_stamp: "2026-05-30T12:00:00.000Z",
      }),
    );

    updateTaxTransaction("approval", { label: "Approval" });
    updateTaxTransaction("trade", { label: "Trade" });
    updateTaxTransaction("transfer", { label: "Transfer" });

    expect(listGermanTaxableTransactions(50, 0).map((row) => row.id)).toEqual([
      "trade",
      "transfer",
      "unlabeled",
    ]);
    expect(listGermanTaxableTransactions(1, 1).map((row) => row.id)).toEqual(["transfer"]);
  });

  it("lists rows needing German tax review as unlabeled only", () => {
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "approval",
        block_number: 103,
        time_stamp: "2026-05-30T12:03:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "trade",
        block_number: 102,
        time_stamp: "2026-05-30T12:02:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled-a",
        block_number: 101,
        time_stamp: "2026-05-30T12:01:00.000Z",
      }),
    );
    upsertSyncedTaxTransaction(
      makeSyncedTaxTransaction({
        id: "unlabeled-b",
        block_number: 100,
        time_stamp: "2026-05-30T12:00:00.000Z",
      }),
    );

    updateTaxTransaction("approval", { label: "Approval" });
    updateTaxTransaction("trade", { label: "Trade" });

    expect(getTaxTransactionsNeedingGermanTaxReview(50, 0).map((row) => row.id)).toEqual([
      "unlabeled-a",
      "unlabeled-b",
    ]);
    expect(getTaxTransactionsNeedingGermanTaxReview(1, 1).map((row) => row.id)).toEqual([
      "unlabeled-b",
    ]);
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
