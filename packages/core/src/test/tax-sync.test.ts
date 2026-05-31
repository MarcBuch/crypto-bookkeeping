import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import { resetDb } from "../db/schema.js";
import {
  getTaxSyncState,
  getTaxTransaction,
  listTaxTransactions,
  updateTaxTransaction,
  upsertTaxSyncState,
} from "../db/store.js";
import { syncTaxTransactions } from "../services/tax-transactions.js";

const TMP = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-tax-sync-tests";
const WALLET = "0x00000000000000000000000000000000000000aa" as `0x${string}`;
const BASE_URL = "https://explorer.test/api";

type ExplorerBody = {
  status?: string;
  message?: string;
  result?: unknown;
};

type RequestRecord = {
  url: string;
  params: URLSearchParams;
};

function config() {
  return {
    wallet: WALLET,
    tax: {
      explorerApiUrl: BASE_URL,
      explorerChainId: 999,
      explorerApiKey: "test-key",
    },
  };
}

function envelope(result: unknown): ExplorerBody {
  return { status: "1", message: "OK", result };
}

function noTransactionsFound(): ExplorerBody {
  return { status: "0", message: "No transactions found", result: "No transactions found" };
}

function unsupportedInternal(): ExplorerBody {
  return { status: "0", message: "NOTOK", result: "Action txlistinternal is not supported" };
}

function tx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    blockNumber: "100",
    timeStamp: "1770000000",
    from: "0xfrom",
    to: "0xto",
    value: "1",
    gasUsed: "21000",
    gasPrice: "1000000000",
    methodId: "0x12345678",
    functionName: "transfer(address,uint256)",
    input: "0xabcdef",
    isError: "0",
    ...overrides,
  };
}

function tokenTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return tx({
    contractAddress: "0xtoken",
    tokenName: "Token",
    tokenSymbol: "TOK",
    tokenDecimal: "18",
    value: "1000000000000000000",
    ...overrides,
  });
}

function makeFetcher(
  route: (
    params: URLSearchParams,
    url: string,
  ) => ExplorerBody | { ok: false; status: number; body?: ExplorerBody },
  requests: RequestRecord[] = [],
) {
  return async (url: string) => {
    const parsed = new URL(url);
    requests.push({ url, params: parsed.searchParams });
    const response = route(parsed.searchParams, url);
    if ("ok" in response && response.ok === false) {
      return {
        ok: false,
        status: response.status,
        json: async () => response.body ?? {},
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  };
}

function actionPages(requests: RequestRecord[], action: string): number[] {
  return requests
    .filter((request) => request.params.get("action") === action)
    .map((request) => Number(request.params.get("page")));
}

describe("tax transaction explorer sync", () => {
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

  it("paginates until a short page and sends stable explorer params", async () => {
    const requests: RequestRecord[] = [];
    const fetcher = makeFetcher((params) => {
      const action = params.get("action");
      const page = params.get("page");
      if (action === "txlist" && page === "1") {
        return envelope([
          tx({ hash: "0xaaa1", blockNumber: "10" }),
          tx({ hash: "0xaaa2", blockNumber: "11" }),
        ]);
      }
      if (action === "txlist" && page === "2") {
        return envelope([tx({ hash: "0xaaa3", blockNumber: "12" })]);
      }
      if (action === "txlistinternal") return unsupportedInternal();
      return envelope([]);
    }, requests);

    const summary = await syncTaxTransactions(config(), {
      fetcher,
      pageSize: 2,
      maxPages: 3,
      startBlock: 9,
      endBlock: 20,
      source: "testsource",
    });

    expect(summary.synced).toBe(3);
    expect(summary.latestBlockNumber).toBe(12);
    expect(actionPages(requests, "txlist")).toEqual([1, 2]);
    expect(actionPages(requests, "tokentx")).toEqual([1]);
    expect(actionPages(requests, "tokennfttx")).toEqual([1]);
    expect(actionPages(requests, "txlistinternal")).toEqual([1]);

    for (const request of requests) {
      expect(request.url.startsWith(`${BASE_URL}?`)).toBe(true);
      expect(request.params.get("chainid")).toBe("999");
      expect(request.params.get("module")).toBe("account");
      expect(request.params.get("address")).toBe(WALLET);
      expect(request.params.get("offset")).toBe("2");
      expect(request.params.get("sort")).toBe("asc");
      expect(request.params.get("apikey")).toBe("test-key");
      expect(request.params.get("startblock")).toBe("9");
      expect(request.params.get("endblock")).toBe("20");
    }
    expect(new Set(listTaxTransactions().map((row) => row.id))).toEqual(
      new Set([
        "testsource:txlist:0xaaa1:external",
        "testsource:txlist:0xaaa2:external",
        "testsource:txlist:0xaaa3:external",
      ]),
    );
  });

  it("uses Hyperscan as the default explorer without requiring an API key", async () => {
    const requests: RequestRecord[] = [];

    await syncTaxTransactions(
      {
        wallet: WALLET,
        tax: {
          explorerApiKey: "YOUR_ETHERSCAN_API_KEY_OPTIONAL",
        },
      },
      {
        fetcher: makeFetcher(() => envelope([]), requests),
      },
    );

    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(request.url.startsWith("https://www.hyperscan.com/api?")).toBe(true);
      expect(request.params.get("apikey")).toBeNull();
    }
  });

  it("fails before fetch when an explicit Etherscan v2 explorer requires a real API key", async () => {
    let called = false;

    await expect(
      syncTaxTransactions(
        {
          wallet: WALLET,
          tax: {
            explorerApiUrl: "https://api.etherscan.io/v2/api",
            explorerApiKey: "YOUR_ETHERSCAN_API_KEY_OPTIONAL",
          },
        },
        {
          fetcher: async () => {
            called = true;
            return {
              ok: true,
              status: 200,
              json: async () => envelope([]),
            };
          },
        },
      ),
    ).rejects.toThrow(
      "Tax transaction sync requires tax.explorerApiKey when using the Etherscan v2 explorer API",
    );
    expect(called).toBe(false);
  });

  it("respects maxPages when every page is full", async () => {
    const requests: RequestRecord[] = [];
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: `0xpage${params.get("page")}a` }),
          tx({ hash: `0xpage${params.get("page")}b` }),
        ]);
      }
      return envelope([]);
    }, requests);

    await syncTaxTransactions(config(), { fetcher, pageSize: 2, maxPages: 2 });

    expect(actionPages(requests, "txlist")).toEqual([1, 2]);
    expect(listTaxTransactions()).toHaveLength(4);
  });

  it("skips malformed rows and treats empty or unsupported explorer responses as empty pages", async () => {
    const fetcher = makeFetcher((params) => {
      const action = params.get("action");
      if (action === "txlist") {
        return envelope([
          tx({ hash: "" }),
          { blockNumber: "111", value: "missing hash" },
          tx({ hash: "0xgood", blockNumber: "112" }),
        ]);
      }
      if (action === "tokentx" || action === "tokennfttx") return noTransactionsFound();
      if (action === "txlistinternal") return unsupportedInternal();
      return envelope([]);
    });

    const summary = await syncTaxTransactions(config(), { fetcher, pageSize: 10 });

    expect(summary.synced).toBe(1);
    expect(listTaxTransactions().map((row) => row.hash)).toEqual(["0xgood"]);
  });

  it("destructures native transfers relative to the configured wallet", async () => {
    const hash = "0x211d72eb6f3afa99f8de8e95ea4b27f5088892721da22672ee6700abdd2216d6";
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({
            hash,
            from: "0x57955467e2fd905dbb3026963a144dcacd566687",
            to: WALLET,
            value: "252451290000000000",
          }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(config(), { fetcher, source: "hyperscan" });

    expect(getTaxTransaction(`hyperscan:txlist:${hash}:external`)).toMatchObject({
      incoming_quantity: "0.25245129",
      incoming_asset: "HYPE",
      outgoing_quantity: null,
      outgoing_asset: null,
    });
  });

  it("destructures token transfers relative to the configured wallet", async () => {
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({
            hash: "0xtokenout",
            logIndex: "4",
            from: WALLET.toUpperCase(),
            to: "0xreceiver",
            value: "25000000",
            tokenSymbol: "USDC",
            tokenDecimal: "6",
          }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(config(), { fetcher, source: "hyperscan" });

    expect(getTaxTransaction("hyperscan:tokentx:0xtokenout:4")).toMatchObject({
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: "25",
      outgoing_asset: "USDC",
    });
  });

  it("throws useful explorer errors without wiping existing metadata or sync state", async () => {
    upsertTaxSyncState({
      wallet: WALLET,
      last_synced_at: "2026-05-30T12:00:00.000Z",
      last_block_number: 321,
      source: "hyperevmscan",
    });
    await syncTaxTransactions(config(), {
      fetcher: makeFetcher((params) =>
        params.get("action") === "txlist"
          ? envelope([tx({ hash: "0xkept", blockNumber: "322" })])
          : envelope([]),
      ),
      source: "hyperevmscan",
    });
    updateTaxTransaction("hyperevmscan:txlist:0xkept:external", {
      label: "Trade",
      comment: "do not lose this",
    });

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return { ok: false, status: 503 };
      }
      return envelope([]);
    });

    await expect(syncTaxTransactions(config(), { fetcher })).rejects.toThrow(
      "Tax transaction sync failed for txlist: HTTP 503",
    );
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 322 });
    expect(getTaxTransaction("hyperevmscan:txlist:0xkept:external")).toMatchObject({
      label: "Trade",
      comment: "do not lose this",
    });

    await expect(
      syncTaxTransactions(config(), {
        fetcher: makeFetcher(() => ({ status: "0", message: "NOTOK" })),
      }),
    ).rejects.toThrow("Tax transaction sync failed for txlist: NOTOK");
  });

  it("preserves row metadata, separates duplicate token logs, and keeps block state on no-row sync", async () => {
    const firstFetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({ hash: "0xtokenhash", logIndex: "1", blockNumber: "200", value: "10" }),
          tokenTx({ hash: "0xtokenhash", logIndex: "2", blockNumber: "201", value: "20" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(config(), { fetcher: firstFetcher, source: "testsource" });
    updateTaxTransaction("testsource:tokentx:0xtokenhash:1", {
      label: "Transfer",
      comment: "manual classification",
    });

    const secondFetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({ hash: "0xtokenhash", logIndex: "1", blockNumber: "200", value: "999" }),
          tokenTx({ hash: "0xtokenhash", logIndex: "2", blockNumber: "201", value: "20" }),
        ]);
      }
      return envelope([]);
    });
    await syncTaxTransactions(config(), { fetcher: secondFetcher, source: "testsource" });

    expect(new Set(listTaxTransactions().map((row) => row.id))).toEqual(
      new Set(["testsource:tokentx:0xtokenhash:1", "testsource:tokentx:0xtokenhash:2"]),
    );
    expect(getTaxTransaction("testsource:tokentx:0xtokenhash:1")).toMatchObject({
      value: "999",
      label: "Transfer",
      comment: "manual classification",
    });
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 201 });

    await syncTaxTransactions(config(), {
      fetcher: makeFetcher(() => envelope([])),
      source: "testsource",
    });
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 201 });
  });

  it("uses transactionHash for Hyperscan internal transactions", async () => {
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlistinternal") {
        return envelope([
          {
            transactionHash: "0xinternalhash",
            blockNumber: "700",
            timeStamp: "1770000000",
            from: "0xfrom",
            to: "0xto",
            value: "123",
            gasUsed: "0",
            gasPrice: "1000000000",
            type: "call",
          },
        ]);
      }
      return envelope([]);
    });

    const summary = await syncTaxTransactions(config(), { fetcher, source: "hyperscan" });

    expect(summary.synced).toBe(1);
    expect(listTaxTransactions()).toMatchObject([
      {
        id: "hyperscan:txlistinternal:0xinternalhash:internal:0xfrom:0xto:123::call",
        hash: "0xinternalhash",
        transaction_type: "txlistinternal",
      },
    ]);
  });

  it("uses stable ids across different page and block bounds without duplicate orphan rows", async () => {
    const row = tx({ hash: "0xstable", blockNumber: "500" });

    await syncTaxTransactions(config(), {
      fetcher: makeFetcher((params) =>
        params.get("action") === "txlist" && params.get("page") === "1"
          ? envelope([{ blockNumber: "499", value: "missing hash keeps pagination moving" }])
          : params.get("action") === "txlist" && params.get("page") === "2"
            ? envelope([row])
            : envelope([]),
      ),
      pageSize: 1,
      maxPages: 2,
      startBlock: 400,
      endBlock: 600,
      source: "testsource",
    });
    await syncTaxTransactions(config(), {
      fetcher: makeFetcher((params) =>
        params.get("action") === "txlist" && params.get("page") === "1"
          ? envelope([row])
          : envelope([]),
      ),
      pageSize: 10,
      maxPages: 1,
      startBlock: 1,
      endBlock: 999,
      source: "testsource",
    });

    expect(listTaxTransactions().map((transaction) => transaction.id)).toEqual([
      "testsource:txlist:0xstable:external",
    ]);
  });

  it("surfaces malformed non-empty explorer responses", async () => {
    await expect(
      syncTaxTransactions(config(), {
        fetcher: makeFetcher(() => ({
          status: "1",
          message: "OK",
          result: { hash: "0xnot-array" },
        })),
      }),
    ).rejects.toThrow("Tax transaction sync failed for txlist: OK");
  });
});
