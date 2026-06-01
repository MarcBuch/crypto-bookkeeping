import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";

import type { FastifyInstance } from "fastify";

import type { Config } from "../config.js";

const fakeConfig: Config = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
};

const fakeTransaction = {
  id: "tx-1:external",
  hash: "0xhash",
  label: "Trade",
};

let lastListArgs: unknown[] = [];
let lastSyncArgs: unknown[] = [];
let lastUpdateArgs: unknown[] = [];
let lastCreateArgs: unknown[] = [];
let allListArgs: unknown[][] = [];
let allSyncArgs: unknown[][] = [];
let allUpdateArgs: unknown[][] = [];
let allCreateArgs: unknown[][] = [];
let mockListTaxTransactions: (...args: unknown[]) => unknown = () => [fakeTransaction];
let mockSyncTaxTransactions: (...args: unknown[]) => unknown = () => ({
  scanned: 2,
  inserted: 1,
  skipped: 1,
});
let mockUpdateTaxTransaction: (...args: unknown[]) => unknown = () => ({
  ...fakeTransaction,
  comment: "Updated comment",
});
let mockCreateManualTaxTransaction: (...args: unknown[]) => unknown = () => fakeTransaction;
let mockEnrichTaxTransactionsEurValues: (...args: unknown[]) => unknown = () => ({
  enriched: 0,
  skipped: 0,
});

mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
  listCachedPositionViews: () => [],
  listCachedPnLViews: () => [],
  getPositionsCacheSyncedAt: () => null,
  syncLpData: async () => ({ synced: 0 }),
  getPnLView: async () => [],
  getILView: async () => [],
  getHistoryView: async () => [],
  listTaxTransactions: (...args: unknown[]) => {
    lastListArgs = args;
    allListArgs.push(args);
    return mockListTaxTransactions(...args);
  },
  syncTaxTransactions: (...args: unknown[]) => {
    lastSyncArgs = args;
    allSyncArgs.push(args);
    return mockSyncTaxTransactions(...args);
  },
  updateTaxTransaction: (...args: unknown[]) => {
    lastUpdateArgs = args;
    allUpdateArgs.push(args);
    return mockUpdateTaxTransaction(...args);
  },
  createManualTaxTransaction: (...args: unknown[]) => {
    lastCreateArgs = args;
    allCreateArgs.push(args);
    return mockCreateManualTaxTransaction(...args);
  },
  enrichTaxTransactionsEurValues: (...args: unknown[]) => {
    return mockEnrichTaxTransactionsEurValues(...args);
  },
  NotFoundError: class NotFoundError extends Error {},
  RpcError: class RpcError extends Error {
    code?: number;
    constructor(msg: string, code?: number) {
      super(msg);
      this.code = code;
    }
  },
  ValidationError: class ValidationError extends Error {},
}));

let server: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import("../index.js");
  server = await buildServer(fakeConfig);
  await server.ready();
});

beforeEach(() => {
  lastListArgs = [];
  lastSyncArgs = [];
  lastUpdateArgs = [];
  lastCreateArgs = [];
  allListArgs = [];
  allSyncArgs = [];
  allUpdateArgs = [];
  allCreateArgs = [];
  mockListTaxTransactions = () => [fakeTransaction];
  mockSyncTaxTransactions = () => ({
    scanned: 2,
    inserted: 1,
    skipped: 1,
  });
  mockUpdateTaxTransaction = () => ({
    ...fakeTransaction,
    comment: "Updated comment",
  });
  mockCreateManualTaxTransaction = () => fakeTransaction;
  mockEnrichTaxTransactionsEurValues = () => ({ enriched: 0, skipped: 0 });
});

describe("GET /tax/transactions", () => {
  it("returns transactions with default pagination", async () => {
    mockListTaxTransactions = () => [fakeTransaction];
    lastListArgs = [];
    lastSyncArgs = [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transactions: [fakeTransaction] });
    expect(lastListArgs).toEqual([50, 0, undefined]);
    expect(lastSyncArgs).toEqual([]);
  });

  it("passes limit, offset, and label filters to core", async () => {
    mockListTaxTransactions = () => [];
    lastListArgs = [];

    const res = await server.inject({
      method: "GET",
      url: "/tax/transactions?limit=10&offset=5&label=Transfer",
    });

    expect(res.statusCode).toBe(200);
    expect(lastListArgs).toEqual([10, 5, "Transfer"]);
  });

  it("clamps limit to 200", async () => {
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions?limit=999" });

    expect(res.statusCode).toBe(200);
    expect(lastListArgs[0]).toBe(200);
  });

  it("rejects invalid label filters", async () => {
    const res = await server.inject({ method: "GET", url: "/tax/transactions?label=Income" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "label must be Trade or Transfer, got: Income" });
  });

  it("rejects lowercase label filters", async () => {
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions?label=trade" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "label must be Trade or Transfer, got: trade" });
    expect(lastListArgs).toEqual([]);
  });

  it.each(["abc", "10abc", "0", "-1"])("rejects invalid limit %s", async (limit) => {
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: `/tax/transactions?limit=${limit}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: `limit must be a positive integer, got: ${limit}` });
    expect(lastListArgs).toEqual([]);
  });

  it("rejects invalid offset", async () => {
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions?offset=-1" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "offset must be a non-negative integer, got: -1",
    });
    expect(lastListArgs).toEqual([]);
  });

  it.each(["abc", "1abc"])("rejects invalid offset %s", async (offset) => {
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: `/tax/transactions?offset=${offset}` });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: `offset must be a non-negative integer, got: ${offset}`,
    });
    expect(lastListArgs).toEqual([]);
  });

  it("accepts very large numeric offsets", async () => {
    mockListTaxTransactions = () => [];
    lastListArgs = [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions?offset=999999999" });

    expect(res.statusCode).toBe(200);
    expect(lastListArgs).toEqual([50, 999999999, undefined]);
  });

  it("returns an empty transactions array when core returns no rows", async () => {
    mockListTaxTransactions = () => [];

    const res = await server.inject({ method: "GET", url: "/tax/transactions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transactions: [] });
  });

  it("passes malformed transaction rows through without crashing", async () => {
    const malformedRows = [
      { id: "tx-2:external", nested: { unexpected: true } },
      { malformed: true },
    ];
    mockListTaxTransactions = () => malformedRows;

    const res = await server.inject({ method: "GET", url: "/tax/transactions" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transactions: malformedRows });
  });

  it("returns 404 for unknown nested transaction routes", async () => {
    const res = await server.inject({ method: "GET", url: "/tax/transactions/foo" });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /tax/transactions/sync", () => {
  it("syncs tax transactions with config and returns summary", async () => {
    const summary = { scanned: 3, inserted: 2, skipped: 1 };
    mockSyncTaxTransactions = () => summary;

    const res = await server.inject({ method: "POST", url: "/tax/transactions/sync" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sync: summary });
    expect(lastSyncArgs).toEqual([fakeConfig]);
  });

  it("returns a controlled 503 error response when sync throws", async () => {
    mockSyncTaxTransactions = () => {
      throw new Error("sync exploded");
    };

    const res = await server.inject({ method: "POST", url: "/tax/transactions/sync" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Failed to sync tax transactions" });
    expect(allSyncArgs).toEqual([[fakeConfig]]);
    expect(allListArgs).toEqual([]);
    expect(lastListArgs).toEqual([]);
  });

  it("returns a controlled 503 error response when sync rejects", async () => {
    mockSyncTaxTransactions = async () => {
      throw new Error("async sync exploded");
    };

    const res = await server.inject({ method: "POST", url: "/tax/transactions/sync" });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "Failed to sync tax transactions" });
    expect(allSyncArgs).toEqual([[fakeConfig]]);
    expect(allListArgs).toEqual([]);
    expect(lastListArgs).toEqual([]);
  });

  it("does not implicitly sync GET requests after a failed POST sync", async () => {
    mockSyncTaxTransactions = () => {
      throw new Error("sync failed");
    };

    const failedSync = await server.inject({ method: "POST", url: "/tax/transactions/sync" });

    expect(failedSync.statusCode).toBe(503);

    mockListTaxTransactions = () => [fakeTransaction];
    const getRes = await server.inject({ method: "GET", url: "/tax/transactions" });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({ transactions: [fakeTransaction] });
    expect(allSyncArgs).toEqual([[fakeConfig]]);
    expect(allListArgs).toEqual([[50, 0, undefined]]);
  });

  it("returns 404 for unsupported GET sync requests", async () => {
    const res = await server.inject({ method: "GET", url: "/tax/transactions/sync" });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Route not found",
      path: "/tax/transactions/sync",
    });
    expect(allSyncArgs).toEqual([]);
    expect(allListArgs).toEqual([]);
  });

  it("passes exactly fastify lpConfig once per sync request without caching", async () => {
    const firstSummary = { scanned: 1, inserted: 1, skipped: 0 };
    const secondSummary = { scanned: 2, inserted: 0, skipped: 2 };
    let syncCount = 0;
    mockSyncTaxTransactions = () => {
      syncCount += 1;
      return syncCount === 1 ? firstSummary : secondSummary;
    };

    const firstRes = await server.inject({ method: "POST", url: "/tax/transactions/sync" });
    const secondRes = await server.inject({ method: "POST", url: "/tax/transactions/sync" });

    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(firstRes.json()).toEqual({ sync: firstSummary });
    expect(secondRes.json()).toEqual({ sync: secondSummary });
    expect(syncCount).toBe(2);
    expect(allSyncArgs).toEqual([[fakeConfig], [fakeConfig]]);
    expect(allListArgs).toEqual([]);
  });
});

describe("POST /tax/transactions", () => {
  it.each([
    ["null", "null"],
    ["array", []],
    ["string", '"invalid"'],
  ])("rejects %s request bodies", async (_name, payload) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "request body must be an object" });
    expect(allCreateArgs).toEqual([]);
  });

  it("creates a manual tax transaction with validated ledger fields", async () => {
    const createdTransaction = { ...fakeTransaction, id: "manual:deposit", source: "manual" };
    mockCreateManualTaxTransaction = () => createdTransaction;

    const payload = {
      id: "Deposit",
      hash: "manual-deposit",
      time_stamp: "2026-05-30T12:00:00.000Z",
      incoming_quantity: "1.5",
      incoming_asset: "HYPE",
      outgoing_quantity: "42.00",
      outgoing_asset: "USDC",
      cost_eur: null,
      proceeds_eur: "45.00",
      gain_eur: "5.00",
      holding_duration_days: 7,
      label: "Trade",
      comment: "Manual deposit",
    };

    const res = await server.inject({ method: "POST", url: "/tax/transactions", payload });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ transaction: createdTransaction });
    expect(lastCreateArgs).toEqual([payload]);
    expect(allListArgs).toEqual([]);
    expect(allSyncArgs).toEqual([]);
    expect(allUpdateArgs).toEqual([]);
  });

  it("passes nullable integer fields through as null after validation", async () => {
    const createdTransaction = { ...fakeTransaction, id: "manual:null-integers" };
    mockCreateManualTaxTransaction = () => createdTransaction;

    const payload = {
      block_number: null,
      token_decimal: null,
      is_error: null,
      holding_duration_days: null,
      comment: "Nullable integer fields",
    };

    const res = await server.inject({ method: "POST", url: "/tax/transactions", payload });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ transaction: createdTransaction });
    expect(allCreateArgs).toEqual([[payload]]);
  });

  it.each(["source", "transaction_type"])("rejects client-controlled %s", async (field) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { [field]: "manual" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: `unknown field: ${field}` });
    expect(allCreateArgs).toEqual([]);
  });

  it("rejects unknown fields beyond reserved source and transaction_type", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { comment: "Known", category: "Unknown" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown field: category" });
    expect(allCreateArgs).toEqual([]);
  });

  it.each([
    ["number", 1],
    ["object", { value: "Trade" }],
    ["empty string", ""],
    ["lowercase", "trade"],
    ["unexpected value", "Income"],
  ])("rejects %s labels", async (_name, label) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { label },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "label must be Trade, Transfer, or null" });
    expect(allCreateArgs).toEqual([]);
  });

  it.each([
    ["number", 1],
    ["object", { value: "Comment" }],
    ["array", ["Comment"]],
  ])("rejects %s comments", async (_name, comment) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { comment },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "comment must be a string or null" });
    expect(allCreateArgs).toEqual([]);
  });

  it("rejects overlong comments", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { comment: "a".repeat(1001) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "comment must be at most 1000 characters" });
    expect(allCreateArgs).toEqual([]);
  });

  it("accepts null label and comment annotations", async () => {
    const createdTransaction = { ...fakeTransaction, label: null, comment: null };
    mockCreateManualTaxTransaction = () => createdTransaction;

    const payload = { label: null, comment: null };

    const res = await server.inject({ method: "POST", url: "/tax/transactions", payload });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ transaction: createdTransaction });
    expect(allCreateArgs).toEqual([[payload]]);
  });

  it.each([
    ["incoming_quantity", 1, "incoming_quantity must be a string or null"],
    ["incoming_asset", { symbol: "HYPE" }, "incoming_asset must be a string or null"],
    ["cost_eur", ["1.00"], "cost_eur must be a string or null"],
  ])("rejects invalid nullable string field %s", async (field, value, error) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { [field]: value },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    expect(allCreateArgs).toEqual([]);
  });

  it.each([
    ["id", null, "id must be a string"],
    ["id", 1, "id must be a string"],
    ["hash", null, "hash must be a string"],
    ["hash", { value: "0xhash" }, "hash must be a string"],
  ])("rejects invalid %s values", async (field, value, error) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { [field]: value },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    expect(allCreateArgs).toEqual([]);
  });

  it.each([
    ["block_number", 1.5, "block_number must be a safe integer or null"],
    ["token_decimal", Number.MAX_SAFE_INTEGER + 1, "token_decimal must be a safe integer or null"],
    ["is_error", "0", "is_error must be a safe integer or null"],
    ["holding_duration_days", -1, "holding_duration_days must be non-negative or null"],
  ])("rejects invalid integer field %s", async (field, value, error) => {
    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { [field]: value },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error });
    expect(allCreateArgs).toEqual([]);
  });

  it("does not affect existing GET or PATCH behavior after rejected manual creates", async () => {
    const rejectedCreate = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { unknown: "field" },
    });

    expect(rejectedCreate.statusCode).toBe(400);

    const getRes = await server.inject({ method: "GET", url: "/tax/transactions" });
    const patchRes = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment: "Still works" },
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({ transactions: [fakeTransaction] });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({
      transaction: { ...fakeTransaction, comment: "Updated comment" },
    });
    expect(allCreateArgs).toEqual([]);
    expect(allListArgs).toEqual([[50, 0, undefined]]);
    expect(allUpdateArgs).toEqual([["tx-1:external", { comment: "Still works" }]]);
  });

  it("returns a controlled 500 error response when manual create throws", async () => {
    mockCreateManualTaxTransaction = () => {
      throw new Error("create exploded");
    };

    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { comment: "Valid manual entry" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Failed to create tax transaction" });
    expect(allCreateArgs).toEqual([[{ comment: "Valid manual entry" }]]);
  });

  it("maps invalid manual id create errors to a controlled 400 response", async () => {
    mockCreateManualTaxTransaction = () => {
      throw new Error("Manual tax transaction id must contain at least one safe character");
    };

    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { id: " -- !! ", comment: "Invalid id" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Manual tax transaction id must contain at least one safe character",
    });
    expect(allCreateArgs).toEqual([[{ id: " -- !! ", comment: "Invalid id" }]]);
  });

  it("maps duplicate manual id create errors to a controlled 409 response", async () => {
    mockCreateManualTaxTransaction = () => {
      throw new Error("Manual tax transaction already exists: manual:deposit");
    };

    const res = await server.inject({
      method: "POST",
      url: "/tax/transactions",
      payload: { id: "deposit", comment: "Duplicate id" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Manual tax transaction already exists: manual:deposit" });
    expect(allCreateArgs).toEqual([[{ id: "deposit", comment: "Duplicate id" }]]);
  });
});

describe("PATCH /tax/transactions/:id", () => {
  it.each([
    ["null", "null"],
    ["array", []],
    ["string", '"invalid"'],
  ])("rejects %s request bodies", async (_name, payload) => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      headers: { "content-type": "application/json" },
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "request body must be an object" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("updates transaction annotations", async () => {
    const updatedTransaction = {
      ...fakeTransaction,
      label: "Transfer",
      comment: "Manual classification",
    };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal%23fee",
      payload: { label: "Transfer", comment: "Manual classification" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(lastUpdateArgs).toEqual([
      "tx-1:external#fee",
      { label: "Transfer", comment: "Manual classification" },
    ]);
  });

  it("updates transaction ids with token fallback discriminators", async () => {
    const id =
      "hyperscan:tokentx:0xd2705aca4c002c9f2ed1a65d5dbfbfb5ccefe45d7b0b248e64037fb753cc62b8:token:0x5555555555555555555555555555555555555555::Wrapped HYPE:WHYPE:25000000000000000000:0x0a0758d937d1059c356d4714e57f5df0239bce1a:0xcbb12c1d36a4c599a1b63ab76f508a179ca1f34d";
    const updatedTransaction = { ...fakeTransaction, id, label: "Trade" };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: `/tax/transactions/${encodeURIComponent(id)}`,
      payload: { label: "Trade" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(lastUpdateArgs).toEqual([id, { label: "Trade" }]);
  });

  it("updates only the label without sending a comment field", async () => {
    const updatedTransaction = { ...fakeTransaction, label: "Transfer" };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { label: "Transfer" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(allUpdateArgs).toEqual([["tx-1:external", { label: "Transfer" }]]);
  });

  it("updates only the comment without sending a label field", async () => {
    const updatedTransaction = { ...fakeTransaction, comment: "Only comment" };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment: "Only comment" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(allUpdateArgs).toEqual([["tx-1:external", { comment: "Only comment" }]]);
  });

  it("accepts full manual ledger property updates", async () => {
    const updatedTransaction = {
      ...fakeTransaction,
      source: "manual",
      hash: "manual-updated",
      block_number: 42,
      incoming_quantity: "2",
      incoming_asset: "HYPE",
      holding_duration_days: 7,
    };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/manual%3Aeditable",
      payload: {
        hash: "manual-updated",
        block_number: 42,
        incoming_quantity: "2",
        incoming_asset: "HYPE",
        holding_duration_days: 7,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(lastUpdateArgs).toEqual([
      "manual:editable",
      {
        hash: "manual-updated",
        block_number: 42,
        incoming_quantity: "2",
        incoming_asset: "HYPE",
        holding_duration_days: 7,
      },
    ]);
  });

  it("returns a controlled validation error when synced rows reject ledger property updates", async () => {
    mockUpdateTaxTransaction = () => {
      throw new Error("Only manual tax transactions can update ledger properties");
    };

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { incoming_quantity: "2" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Only manual tax transactions can update ledger properties",
    });
    expect(allUpdateArgs).toEqual([["tx-1:external", { incoming_quantity: "2" }]]);
  });

  it("returns 404 when the transaction does not exist", async () => {
    mockUpdateTaxTransaction = () => null;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/missing%3Aid",
      payload: { comment: "Does not exist" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Tax transaction not found", id: "missing:id" });
    expect(lastUpdateArgs).toEqual(["missing:id", { comment: "Does not exist" }]);
  });

  it("returns 404 for an unknown transaction id containing an encoded slash", async () => {
    mockUpdateTaxTransaction = () => null;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/missing%2Fslash%3Aid",
      payload: { comment: "Does not exist" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Tax transaction not found", id: "missing/slash:id" });
    expect(lastUpdateArgs).toEqual(["missing/slash:id", { comment: "Does not exist" }]);
  });

  it("rejects invalid labels", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { label: "Income" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "label must be Trade, Transfer, or null" });
    expect(allUpdateArgs).toEqual([]);
  });

  it.each([
    ["number", 1],
    ["object", { value: "Trade" }],
    ["empty string", ""],
    ["lowercase", "trade"],
  ])("rejects %s labels", async (_name, label) => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { label },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "label must be Trade, Transfer, or null" });
    expect(allUpdateArgs).toEqual([]);
  });

  it.each([
    ["number", 1],
    ["object", { value: "Comment" }],
    ["array", ["Comment"]],
  ])("rejects %s comments", async (_name, comment) => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "comment must be a string or null" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("accepts null annotations", async () => {
    const updatedTransaction = { ...fakeTransaction, label: null, comment: null };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { label: null, comment: null },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(lastUpdateArgs).toEqual(["tx-1:external", { label: null, comment: null }]);
  });

  it("rejects unknown fields", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment: "Known", category: "Unknown" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "unknown field: category" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("rejects empty updates", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "request body must include at least one editable field" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("rejects invalid manual update integer fields", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/manual%3Aeditable",
      payload: { holding_duration_days: -1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "holding_duration_days must be non-negative or null" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("rejects overlong comments", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment: "a".repeat(1001) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "comment must be at most 1000 characters" });
    expect(allUpdateArgs).toEqual([]);
  });

  it("accepts comments exactly 1000 characters long", async () => {
    const comment = "a".repeat(1000);
    const updatedTransaction = { ...fakeTransaction, comment };
    mockUpdateTaxTransaction = () => updatedTransaction;

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ transaction: updatedTransaction });
    expect(allUpdateArgs).toEqual([["tx-1:external", { comment }]]);
  });

  it("returns a controlled 500 error response when update throws", async () => {
    mockUpdateTaxTransaction = () => {
      throw new Error("update exploded");
    };

    const res = await server.inject({
      method: "PATCH",
      url: "/tax/transactions/tx-1%3Aexternal",
      payload: { comment: "Valid comment" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "Failed to update tax transaction" });
    expect(allUpdateArgs).toEqual([["tx-1:external", { comment: "Valid comment" }]]);
  });
});

describe("POST /tax/transactions/enrich", () => {
  it("returns { enriched: 0, skipped: 0 } when mock returns empty result (no unenriched rows)", async () => {
    mockEnrichTaxTransactionsEurValues = () => ({ enriched: 0, skipped: 0 });

    const res = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enriched: 0, skipped: 0 });
  });

  it("response body has exactly enriched (number) and skipped (number) fields", async () => {
    mockEnrichTaxTransactionsEurValues = () => ({ enriched: 3, skipped: 1 });

    const res = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.enriched).toBe("number");
    expect(typeof body.skipped).toBe("number");
    expect(Object.keys(body).sort()).toEqual(["enriched", "skipped"]);
  });

  it("returns enriched > 0 when unenriched rows exist and service enriches them", async () => {
    mockEnrichTaxTransactionsEurValues = () => ({ enriched: 5, skipped: 2 });

    const res = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enriched: 5, skipped: 2 });
  });

  it("returns skipped > 0 when service cannot fetch prices (simulated fetch failure)", async () => {
    mockEnrichTaxTransactionsEurValues = () => ({ enriched: 0, skipped: 4 });

    const res = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skipped).toBeGreaterThan(0);
    expect(body.enriched).toBe(0);
  });

  it("passes lpConfig to enrichTaxTransactionsEurValues", async () => {
    let capturedArgs: unknown[] = [];
    mockEnrichTaxTransactionsEurValues = (...args: unknown[]) => {
      capturedArgs = args;
      return { enriched: 0, skipped: 0 };
    };

    const res = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(200);
    expect(capturedArgs).toEqual([fakeConfig]);
  });

  it("returns 404 for GET /tax/transactions/enrich (route is POST-only)", async () => {
    const res = await server.inject({ method: "GET", url: "/tax/transactions/enrich" });

    expect(res.statusCode).toBe(404);
  });

  it("does not affect GET /tax/transactions after a successful enrich", async () => {
    mockEnrichTaxTransactionsEurValues = () => ({ enriched: 2, skipped: 0 });
    mockListTaxTransactions = () => [fakeTransaction];

    const enrichRes = await server.inject({ method: "POST", url: "/tax/transactions/enrich" });
    expect(enrichRes.statusCode).toBe(200);

    const getRes = await server.inject({ method: "GET", url: "/tax/transactions" });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({ transactions: [fakeTransaction] });
  });
});
