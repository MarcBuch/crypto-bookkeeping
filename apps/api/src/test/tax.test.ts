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
let allListArgs: unknown[][] = [];
let allSyncArgs: unknown[][] = [];
let allUpdateArgs: unknown[][] = [];
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

mock.module("@lp-tracker/core", () => ({
  loadConfig: () => fakeConfig,
  resolveConfigPath: () => "/fake/config.json",
  getPositionsView: async () => [],
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
  allListArgs = [];
  allSyncArgs = [];
  allUpdateArgs = [];
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
    expect(res.json()).toEqual({ error: "request body must include label or comment" });
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
