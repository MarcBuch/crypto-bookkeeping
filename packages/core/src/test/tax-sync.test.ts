import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import { resetDb } from "../db/schema.js";
import {
  getTaxSyncState,
  getTaxTransaction,
  getTaxTransactionsNeedingEurEnrichment,
  listTaxTransactions,
  updateTaxTransaction,
  updateTaxTransactionEurValues,
  upsertSyncedTaxTransaction,
  upsertTaxSyncState,
} from "../db/store.js";
import { enrichTaxTransactionsEurValues, syncTaxTransactions } from "../services/tax-transactions.js";

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

describe("syncTaxTransactions — EUR enrichment (transaction shape)", () => {
  function configWithPricing() {
    return {
      ...config(),
      pricing: { coingeckoIds: { HYPE: "hyperliquid", USDC: "usd-coin", TOK: "test-token-id" } },
    };
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("null time_stamp → EUR fields stay null", async () => {
    let cgCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("coingecko.com")) {
        cgCallCount++;
      }
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xnullts1", timeStamp: "", from: "0xsender", to: WALLET, value: "1000000000000000000" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest" });

    const row = listTaxTransactions().find((r) => r.hash === "0xnullts1");
    expect(row).toBeDefined();
    expect(row!.cost_eur).toBeNull();
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBeNull();
    expect(cgCallCount).toBe(0);
  });

  it("null incoming_asset AND null outgoing_asset → EUR fields stay null", async () => {
    let cgCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("coingecko.com")) {
        cgCallCount++;
      }
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    // txlistinternal where neither from nor to matches the wallet
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlistinternal") {
        return envelope([
          {
            transactionHash: "0xnomatch1",
            blockNumber: "800",
            timeStamp: "1770001000",
            from: "0xsomebody",
            to: "0xsomeoneelse",
            value: "500000000000000000",
            gasUsed: "0",
            gasPrice: "1000000000",
            type: "call",
          },
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest2" });

    const rows = listTaxTransactions();
    const row = rows.find((r) => r.hash === "0xnomatch1");
    expect(row).toBeDefined();
    expect(row!.incoming_asset).toBeNull();
    expect(row!.outgoing_asset).toBeNull();
    expect(row!.cost_eur).toBeNull();
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBeNull();
    expect(cgCallCount).toBe(0);
  });

  it("incoming-only transfer (received HYPE) → proceeds_eur set, cost_eur null, gain_eur = proceeds", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com") && urlStr.includes("hyperliquid")) {
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 20.0 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xincoming1", timeStamp: "1770002000", from: "0xsender", to: WALLET, value: "2000000000000000000" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest3" });

    const row = listTaxTransactions().find((r) => r.hash === "0xincoming1");
    expect(row).toBeDefined();
    expect(row!.incoming_asset).toBe("HYPE");
    expect(row!.outgoing_asset).toBeNull();
    expect(row!.proceeds_eur).toBe("40");
    expect(row!.cost_eur).toBeNull();
    expect(row!.gain_eur).toBe("40");
  });

  it("outgoing-only transfer (sent HYPE) → cost_eur set, proceeds_eur null, gain_eur = -cost", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com") && urlStr.includes("hyperliquid")) {
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 20.0 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xoutgoing1", timeStamp: "1770003000", from: WALLET, to: "0xrecipient", value: "3000000000000000000" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest4" });

    const row = listTaxTransactions().find((r) => r.hash === "0xoutgoing1");
    expect(row).toBeDefined();
    expect(row!.outgoing_asset).toBe("HYPE");
    expect(row!.incoming_asset).toBeNull();
    expect(row!.cost_eur).toBe("60");
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBe("-60");
  });

  it("asset without coingeckoId mapping → EUR fields stay null", async () => {
    let cgCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("coingecko.com")) {
        cgCallCount++;
      }
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({
            hash: "0xunknownasset1",
            logIndex: "1",
            timeStamp: "1770005000",
            from: "0xsender",
            to: WALLET,
            value: "1000000000000000000",
            tokenSymbol: "UNKNOWN_TOKEN_XYZ",
            tokenDecimal: "18",
          }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest6" });

    const row = listTaxTransactions().find((r) => r.hash === "0xunknownasset1");
    expect(row).toBeDefined();
    expect(row!.cost_eur).toBeNull();
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBeNull();
    expect(cgCallCount).toBe(0);
  });

  it("USDC token transfer out → correct decimal handling", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com") && urlStr.includes("usd-coin")) {
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 0.92 } } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({
            hash: "0xusdcout1",
            logIndex: "7",
            timeStamp: "1770004000",
            from: WALLET,
            to: "0xrecipient",
            value: "50000000",
            tokenSymbol: "USDC",
            tokenDecimal: "6",
          }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing(), { fetcher, source: "eurtest5" });

    const row = listTaxTransactions().find((r) => r.hash === "0xusdcout1");
    expect(row).toBeDefined();
    expect(row!.outgoing_asset).toBe("USDC");
    expect(row!.incoming_asset).toBeNull();
    expect(row!.cost_eur).toBe("46");
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBe("-46");
  });
});

describe("syncTaxTransactions — EUR enrichment (resilience and value preservation)", () => {
  function configWithPricing(coingeckoIds: Record<string, string>) {
    return { ...config(), pricing: { coingeckoIds } };
  }

  const originalFetchResil = globalThis.fetch;
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    process.env.LP_TRACKER_DATA_DIR = join(TMP, crypto.randomUUID());
    resetDb();
  });
  afterEach(() => {
    globalThis.fetch = originalFetchResil;
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("CoinGecko unavailable → sync completes, EUR fields all null", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        throw new Error("network down");
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xresil1", timeStamp: "1770010000", from: "0xsender", to: WALLET, value: "1000000000000000000" }),
        ]);
      }
      return envelope([]);
    });

    await expect(
      syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-1" }), { fetcher, source: "resil1" }),
    ).resolves.toBeDefined();

    const row = listTaxTransactions().find((r) => r.hash === "0xresil1");
    expect(row).toBeDefined();
    expect(row!.cost_eur).toBeNull();
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.gain_eur).toBeNull();
  });

  it("API failure for asset A, success for asset B → partial enrichment", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        if (urlStr.includes("resilience-hype")) throw new Error("network down");
        if (urlStr.includes("resilience-usdc")) {
          return { ok: true, json: async () => ({ market_data: { current_price: { eur: 0.9 } } }) } as Response;
        }
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xresil2hype", timeStamp: "1770011000", from: "0xsender", to: WALLET, value: "1000000000000000000" }),
        ]);
      }
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({
            hash: "0xresil2usdc",
            logIndex: "1",
            timeStamp: "1770011001",
            from: "0xsender",
            to: WALLET,
            value: "1000000",
            tokenSymbol: "USDC",
            tokenDecimal: "6",
          }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(
      configWithPricing({ HYPE: "resilience-hype", USDC: "resilience-usdc" }),
      { fetcher, source: "resil2" },
    );

    const hypeRow = listTaxTransactions().find((r) => r.hash === "0xresil2hype");
    expect(hypeRow).toBeDefined();
    expect(hypeRow!.proceeds_eur).toBeNull();
    expect(hypeRow!.cost_eur).toBeNull();
    expect(hypeRow!.gain_eur).toBeNull();

    const usdcRow = listTaxTransactions().find((r) => r.hash === "0xresil2usdc");
    expect(usdcRow).toBeDefined();
    expect(usdcRow!.proceeds_eur).not.toBeNull();
  });

  it("re-sync preserves existing cost_eur (upsert does NOT overwrite EUR values)", async () => {
    // First sync: CoinGecko returns price 10.0
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        return { ok: true, json: async () => ({ market_data: { current_price: { eur: 10.0 } } }) } as Response;
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const fetcher1 = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xresil3", timeStamp: "1770012000", from: "0xsender", to: WALLET, value: "252451290000000000" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-3" }), { fetcher: fetcher1, source: "resil3" });

    const rowAfterFirst = listTaxTransactions().find((r) => r.hash === "0xresil3");
    expect(rowAfterFirst).toBeDefined();
    const originalProceedsEur = rowAfterFirst!.proceeds_eur;
    expect(originalProceedsEur).not.toBeNull();

    // Second sync: CoinGecko would return 99.0 but upsert should NOT overwrite
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        return { ok: true, json: async () => ({ market_data: { current_price: { eur: 99.0 } } }) } as Response;
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const fetcher2 = makeFetcher((params) => {
      if (params.get("action") === "txlist") {
        return envelope([
          tx({ hash: "0xresil3", timeStamp: "1770012000", from: "0xsender", to: WALLET, value: "999999999999999999" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-3" }), { fetcher: fetcher2, source: "resil3" });

    const rowAfterSecond = listTaxTransactions().find((r) => r.hash === "0xresil3");
    expect(rowAfterSecond).toBeDefined();
    expect(rowAfterSecond!.proceeds_eur).toBe(originalProceedsEur);
  });

  it("deduplicates CoinGecko calls: 5 transactions with same asset and date → 1 API call", async () => {
    const cgCalls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        cgCalls.push(urlStr);
        return {
          ok: true,
          json: async () => ({ market_data: { current_price: { eur: 5.0 } } }),
        } as Response;
      }
      throw new Error(`unexpected globalThis.fetch call: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "tokentx") {
        return envelope([
          tokenTx({ hash: "0xdedup1", logIndex: "1", from: "0xsender", to: WALLET, tokenSymbol: "DEDUP_TOK", tokenDecimal: "18", value: "1000000000000000000", timeStamp: "1770100000" }),
          tokenTx({ hash: "0xdedup2", logIndex: "2", from: "0xsender", to: WALLET, tokenSymbol: "DEDUP_TOK", tokenDecimal: "18", value: "1000000000000000000", timeStamp: "1770100000" }),
          tokenTx({ hash: "0xdedup3", logIndex: "3", from: "0xsender", to: WALLET, tokenSymbol: "DEDUP_TOK", tokenDecimal: "18", value: "1000000000000000000", timeStamp: "1770100000" }),
          tokenTx({ hash: "0xdedup4", logIndex: "4", from: "0xsender", to: WALLET, tokenSymbol: "DEDUP_TOK", tokenDecimal: "18", value: "1000000000000000000", timeStamp: "1770100000" }),
          tokenTx({ hash: "0xdedup5", logIndex: "5", from: "0xsender", to: WALLET, tokenSymbol: "DEDUP_TOK", tokenDecimal: "18", value: "1000000000000000000", timeStamp: "1770100000" }),
        ]);
      }
      return envelope([]);
    });

    await syncTaxTransactions(
      { ...config(), pricing: { coingeckoIds: { DEDUP_TOK: "dedup-coingecko-id" } } },
      { fetcher, source: "dedup-test" },
    );

    // Only 1 CoinGecko call despite 5 transactions with same asset+date
    expect(cgCalls).toHaveLength(1);

    // All 5 rows should have EUR values
    const rows = listTaxTransactions();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.proceeds_eur).not.toBeNull();
      expect(row.gain_eur).not.toBeNull();
    }
  });
});

describe("DB EUR update functions", () => {
  const TMP_EUR = "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-db-eur-tests";

  function makeRow(id: string, overrides: Partial<import("../db/store.js").SyncedTaxTransaction> = {}): import("../db/store.js").SyncedTaxTransaction {
    return {
      id,
      hash: id,
      block_number: 100,
      time_stamp: "1770000000",
      from_address: "0xfrom",
      to_address: "0xto",
      value: "1000000000000000000",
      gas_used: "21000",
      gas_price: "1000000000",
      fee: null,
      method_id: null,
      function_name: null,
      input: null,
      contract_address: null,
      token_symbol: null,
      token_decimal: null,
      token_name: null,
      transaction_type: "txlist",
      source: "testsource",
      is_error: 0,
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      cost_eur: null,
      proceeds_eur: null,
      gain_eur: null,
      holding_duration_days: null,
      synced_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    mkdirSync(TMP_EUR, { recursive: true });
    process.env.LP_TRACKER_DATA_DIR = join(TMP_EUR, crypto.randomUUID());
    resetDb();
  });

  afterEach(() => {
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    rmSync(TMP_EUR, { recursive: true, force: true });
  });

  // Test 1: getTaxTransactionsNeedingEurEnrichment returns only null-EUR rows
  it("getTaxTransactionsNeedingEurEnrichment — returns only rows where both EUR fields are null", () => {
    upsertSyncedTaxTransaction(makeRow("dbeur-t1-row1", { cost_eur: null, proceeds_eur: null }));
    upsertSyncedTaxTransaction(makeRow("dbeur-t1-row2", { cost_eur: null, proceeds_eur: null }));
    upsertSyncedTaxTransaction(makeRow("dbeur-t1-row3", { proceeds_eur: "50", cost_eur: null }));

    const result = getTaxTransactionsNeedingEurEnrichment();
    const ids = result.map((r) => r.id);

    expect(ids).toContain("dbeur-t1-row1");
    expect(ids).toContain("dbeur-t1-row2");
    expect(ids).not.toContain("dbeur-t1-row3");
    expect(result).toHaveLength(2);
  });

  // Test 2: excludes rows where only one EUR field is set
  it("getTaxTransactionsNeedingEurEnrichment — excludes row with cost_eur set but proceeds_eur null", () => {
    upsertSyncedTaxTransaction(makeRow("dbeur-t2-row1", { cost_eur: "30", proceeds_eur: null }));

    const result = getTaxTransactionsNeedingEurEnrichment();
    const ids = result.map((r) => r.id);

    expect(ids).not.toContain("dbeur-t2-row1");
  });

  // Test 3: updateTaxTransactionEurValues — non-existent id is a no-op
  it("updateTaxTransactionEurValues — non-existent id does not throw", () => {
    expect(() =>
      updateTaxTransactionEurValues("nonexistent-id", {
        cost_eur: "5",
        proceeds_eur: "5",
        gain_eur: "5",
      }),
    ).not.toThrow();
  });

  // Test 4: updateTaxTransactionEurValues — updates all three fields
  it("updateTaxTransactionEurValues — updates cost_eur, proceeds_eur, and gain_eur", () => {
    upsertSyncedTaxTransaction(makeRow("dbeur-t4-row1"));

    updateTaxTransactionEurValues("dbeur-t4-row1", {
      cost_eur: "10",
      proceeds_eur: "20",
      gain_eur: "10",
    });

    const row = getTaxTransaction("dbeur-t4-row1");
    expect(row).not.toBeNull();
    expect(row!.cost_eur).toBe("10");
    expect(row!.proceeds_eur).toBe("20");
    expect(row!.gain_eur).toBe("10");
  });

  // Test 5: updateTaxTransactionEurValues — partial null values (field isolation)
  it("updateTaxTransactionEurValues — allows cost_eur null while setting proceeds_eur and gain_eur", () => {
    upsertSyncedTaxTransaction(makeRow("dbeur-t5-row1"));

    updateTaxTransactionEurValues("dbeur-t5-row1", {
      cost_eur: null,
      proceeds_eur: "15",
      gain_eur: "15",
    });

    const row = getTaxTransaction("dbeur-t5-row1");
    expect(row).not.toBeNull();
    expect(row!.cost_eur).toBeNull();
    expect(row!.proceeds_eur).toBe("15");
    expect(row!.gain_eur).toBe("15");
  });

  // Test 6: updateTaxTransactionEurValues — does not clobber other fields
  it("updateTaxTransactionEurValues — does not overwrite unrelated fields", () => {
    upsertSyncedTaxTransaction(
      makeRow("dbeur-t6-row1", {
        incoming_asset: "HYPE",
        incoming_quantity: "2.5",
      }),
    );

    updateTaxTransactionEurValues("dbeur-t6-row1", {
      cost_eur: "100",
      proceeds_eur: "200",
      gain_eur: "100",
    });

    const row = getTaxTransaction("dbeur-t6-row1");
    expect(row).not.toBeNull();
    expect(row!.incoming_asset).toBe("HYPE");
    expect(row!.incoming_quantity).toBe("2.5");
    expect(row!.cost_eur).toBe("100");
    expect(row!.proceeds_eur).toBe("200");
    expect(row!.gain_eur).toBe("100");
  });
});

describe("enrichTaxTransactionsEurValues — backfill service", () => {
  const TMP_BACKFILL =
    "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-backfill-tests";

  function configWithPricing(coingeckoIds: Record<string, string>) {
    return {
      ...config(),
      pricing: { coingeckoIds },
    };
  }

  function makeRow(
    id: string,
    overrides: Partial<import("../db/store.js").SyncedTaxTransaction> = {},
  ): import("../db/store.js").SyncedTaxTransaction {
    return {
      id,
      hash: id,
      block_number: 100,
      time_stamp: new Date(1770000000 * 1000).toISOString(),
      from_address: "0xfrom",
      to_address: "0xto",
      value: "1000000000000000000",
      gas_used: "21000",
      gas_price: "1000000000",
      fee: null,
      method_id: null,
      function_name: null,
      input: null,
      contract_address: null,
      token_symbol: null,
      token_decimal: null,
      token_name: null,
      transaction_type: "txlist",
      source: "backfill-test",
      is_error: 0,
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: null,
      outgoing_asset: null,
      cost_eur: null,
      proceeds_eur: null,
      gain_eur: null,
      holding_duration_days: null,
      synced_at: new Date().toISOString(),
      ...overrides,
    };
  }

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mkdirSync(TMP_BACKFILL, { recursive: true });
    process.env.LP_TRACKER_DATA_DIR = join(TMP_BACKFILL, crypto.randomUUID());
    resetDb();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    rmSync(TMP_BACKFILL, { recursive: true, force: true });
  });

  // Test 1 — already-enriched rows are not in the enrichment queue
  it("already-enriched rows are not re-processed (DB query filters them out)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not call fetch for already-enriched rows");
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t1-row1", { incoming_asset: "BACKFILL_TOK", incoming_quantity: "2" }),
    );
    updateTaxTransactionEurValues("backfill-t1-row1", {
      cost_eur: null,
      proceeds_eur: "20",
      gain_eur: "20",
    });

    const result = await enrichTaxTransactionsEurValues(
      configWithPricing({ BACKFILL_TOK: "backfill-token" }),
    );

    // Row is not in the enrichment queue (already has proceeds_eur set), so counts are both 0
    expect(result.enriched).toBe(0);
    expect(result.skipped).toBe(0);

    // EUR values must remain unchanged
    const row = getTaxTransaction("backfill-t1-row1");
    expect(row!.proceeds_eur).toBe("20");
    expect(row!.gain_eur).toBe("20");
    expect(row!.cost_eur).toBeNull();
  });

  // Test 2 — rows with null asset are skipped
  it("rows with null asset_in and null asset_out are skipped", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not call fetch for null-asset rows");
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t2-row1", {
        incoming_asset: null,
        outgoing_asset: null,
        time_stamp: "1770000000",
      }),
    );

    const result = await enrichTaxTransactionsEurValues(configWithPricing({}));

    expect(result.skipped).toBe(1);
    expect(result.enriched).toBe(0);
  });

  // Test 3 — rows with null timestamp are skipped
  it("rows with null timestamp are skipped", async () => {
    globalThis.fetch = (async () => {
      throw new Error("should not call fetch for null-timestamp rows");
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t3-row1", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "1",
        time_stamp: null,
      }),
    );

    const result = await enrichTaxTransactionsEurValues(
      configWithPricing({ BACKFILL_TOK: "backfill-token" }),
    );

    expect(result.skipped).toBe(1);
    expect(result.enriched).toBe(0);
  });

  // Test 4 — CoinGecko returns HTTP 500 → row is skipped, EUR fields remain null
  it("CoinGecko HTTP 500 → row is skipped, EUR fields remain null", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        return new Response("{}", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t4-row1", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "2",
        time_stamp: new Date(1770100000 * 1000).toISOString(),
      }),
    );

    const result = await enrichTaxTransactionsEurValues(
      configWithPricing({ BACKFILL_TOK: "backfill-token" }),
    );

    expect(result.skipped).toBe(1);
    expect(result.enriched).toBe(0);

    const row = getTaxTransaction("backfill-t4-row1");
    expect(row!.proceeds_eur).toBeNull();
    expect(row!.cost_eur).toBeNull();
    expect(row!.gain_eur).toBeNull();
  });

  // Test 5 — successful enrichment: incoming-only (BACKFILL_TOK transfer)
  it("incoming-only row is enriched: proceeds_eur = qty * price, cost_eur null, gain_eur = proceeds_eur", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com") && urlStr.includes("backfill-token")) {
        return new Response(
          JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t5-row1", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "2",
        outgoing_asset: null,
        outgoing_quantity: null,
        time_stamp: new Date(1770200000 * 1000).toISOString(),
      }),
    );

    const result = await enrichTaxTransactionsEurValues(
      configWithPricing({ BACKFILL_TOK: "backfill-token" }),
    );

    expect(result.enriched).toBe(1);
    expect(result.skipped).toBe(0);

    const row = getTaxTransaction("backfill-t5-row1");
    expect(row!.proceeds_eur).toBe("20");
    expect(row!.cost_eur).toBeNull();
    expect(row!.gain_eur).toBe("20");
  });

  // Test 6 — partial failure: one row succeeds, one fails CoinGecko lookup
  it("partial failure: enriched === 1, skipped === 1 when one CoinGecko lookup fails", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com") && urlStr.includes("backfill-token")) {
        return new Response(
          JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }),
          { status: 200 },
        );
      }
      if (urlStr.includes("coingecko.com")) {
        return new Response("{}", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeRow("backfill-t6-known", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "1",
        time_stamp: new Date(1770300000 * 1000).toISOString(),
      }),
    );
    upsertSyncedTaxTransaction(
      makeRow("backfill-t6-unknown", {
        incoming_asset: "UNKNOWN_BACKFILL",
        incoming_quantity: "1",
        time_stamp: new Date(1770300000 * 1000).toISOString(),
      }),
    );

    const result = await enrichTaxTransactionsEurValues(
      configWithPricing({ BACKFILL_TOK: "backfill-token" }),
    );

    expect(result.enriched).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
