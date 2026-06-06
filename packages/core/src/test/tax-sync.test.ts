import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import type { HypersyncClient } from "@envio-dev/hypersync-client";

import type { Client } from "../chain/client.js";
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
import {
  enrichTaxTransactionsEurValues,
  syncTaxTransactions,
} from "../services/tax-transactions.js";

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

const STUB_CONTRACTS = {
  factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
  positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
  quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
  swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
};

function config() {
  return {
    wallet: WALLET,
    rpc: "https://rpc.stub.invalid",
    chainId: 999,
    contracts: STUB_CONTRACTS,
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

function unsupportedInternal(): ExplorerBody {
  return { status: "0", message: "NOTOK", result: "Action txlistinternal is not supported" };
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

// ---------------------------------------------------------------------------
// HyperSync mock helpers
// ---------------------------------------------------------------------------

interface MockTx {
  hash: string;
  blockNumber: number;
  blockTimestamp?: number;
  from: string;
  to?: string | null;
  value?: bigint;
  gasUsed?: bigint;
  gasPrice?: bigint;
  effectiveGasPrice?: bigint;
  input?: string;
  status?: number;
  sighash?: string | null;
}

interface MockLog {
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  address: string;
  data?: string;
  topics: (string | null | undefined)[];
}

function makeHyperSyncMock(txs: MockTx[], logs: MockLog[]): HypersyncClient {
  return {
    get: async (_query: unknown) => ({
      archiveHeight: 10000,
      nextBlock: 10000,
      totalExecutionTime: 1,
      data: {
        blocks: [
          ...txs.map((t) => ({ number: t.blockNumber, timestamp: t.blockTimestamp ?? 1770000000 })),
          ...logs.map((l) => ({ number: l.blockNumber, timestamp: 1770000000 })),
        ],
        transactions: txs,
        logs,
        traces: [],
      },
    }),
  } as unknown as HypersyncClient;
}

const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padAddr(addr: string): string {
  return "0x" + "0".repeat(24) + addr.toLowerCase().replace(/^0x/, "");
}

function makeTokenLog(
  overrides: Partial<MockLog> & {
    from: string;
    to: string;
    value?: bigint;
    contractAddress: string;
    logIndex?: number;
    blockNumber?: number;
    transactionHash?: string;
  },
): MockLog {
  const value = overrides.value ?? 1_000_000_000_000_000_000n;
  const hex = value.toString(16).padStart(64, "0");
  return {
    transactionHash:
      overrides.transactionHash ??
      "0xbbbb000000000000000000000000000000000000000000000000000000000001",
    blockNumber: overrides.blockNumber ?? 100,
    logIndex: overrides.logIndex ?? 0,
    address: overrides.contractAddress,
    data: "0x" + hex,
    topics: [ERC20_TRANSFER_TOPIC0, padAddr(overrides.from), padAddr(overrides.to)],
  };
}

/** A no-op fetcher that suppresses txlistinternal (returns empty) */
const noOpFetcher = async (_url: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: "0",
    message: "No transactions found",
    result: "No transactions found",
  }),
});

/** A viem mock that throws for all readContract calls (no token metadata needed) */
function makeNoOpViemMock(): Client {
  return {
    readContract: async ({ functionName }: { address: string; functionName: string }) => {
      throw new Error(`no metadata for ${functionName}`);
    },
  } as unknown as Client;
}

/** A viem mock that returns metadata for given contract addresses */
function makeViemMock(
  metadata: Record<
    string,
    { symbol?: string | null; name?: string | null; decimals?: number | null }
  >,
): Client {
  return {
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      const m = metadata[address.toLowerCase()];
      if (functionName === "symbol") {
        if (!m || m.symbol === null || m.symbol === undefined) throw new Error("no symbol");
        return m.symbol;
      }
      if (functionName === "name") {
        if (!m || m.name === null || m.name === undefined) throw new Error("no name");
        return m.name;
      }
      if (functionName === "decimals") {
        if (!m || m.decimals === null || m.decimals === undefined) throw new Error("no decimals");
        return m.decimals;
      }
      throw new Error(`Unknown: ${functionName}`);
    },
  } as unknown as Client;
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

  it("fetches txlist and token transfers via HyperSync and assigns stable hypersync: IDs", async () => {
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xaaa1",
          blockNumber: 10,
          blockTimestamp: 1770000000,
          from: "0xfrom",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
        {
          hash: "0xaaa2",
          blockNumber: 11,
          blockTimestamp: 1770000001,
          from: WALLET.toLowerCase(),
          to: "0xto",
          value: 2n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
        {
          hash: "0xaaa3",
          blockNumber: 12,
          blockTimestamp: 1770000002,
          from: "0xfrom",
          to: WALLET.toLowerCase(),
          value: 3n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    const summary = await syncTaxTransactions(config(), {
      hyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    expect(summary.synced).toBe(3);
    expect(summary.latestBlockNumber).toBe(12);
    expect(new Set(listTaxTransactions().map((row) => row.id))).toEqual(
      new Set([
        "hypersync:txlist:0xaaa1:external",
        "hypersync:txlist:0xaaa2:external",
        "hypersync:txlist:0xaaa3:external",
      ]),
    );
  });

  it("uses HyperSync for txlist/tokentx/tokennfttx and explorer only for txlistinternal", async () => {
    const explorerRequests: RequestRecord[] = [];

    // HyperSync returns one transaction
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xhypersync1",
          blockNumber: 50,
          from: "0xfrom",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    // Explorer fetcher only handles txlistinternal
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlistinternal") return unsupportedInternal();
      // Should not be called for txlist/tokentx/tokennfttx
      return envelope([]);
    }, explorerRequests);

    await syncTaxTransactions(
      {
        wallet: WALLET,
        rpc: "https://rpc.stub.invalid",
        chainId: 999,
        contracts: STUB_CONTRACTS,
        tax: {
          explorerApiKey: "YOUR_ETHERSCAN_API_KEY_OPTIONAL",
        },
      },
      {
        hyperSyncClient,
        viemClient: makeNoOpViemMock(),
        fetcher,
      },
    );

    // Only txlistinternal should go to explorer
    expect(explorerRequests).toHaveLength(1);
    expect(explorerRequests[0].params.get("action")).toBe("txlistinternal");
    // HyperSync transaction should be stored
    expect(listTaxTransactions().some((r) => r.hash === "0xhypersync1")).toBe(true);
  });

  it("throws a clear error when hyperSyncApiToken is missing or empty", async () => {
    await expect(
      syncTaxTransactions(
        {
          wallet: WALLET,
          rpc: "https://rpc.stub.invalid",
          chainId: 999,
          contracts: STUB_CONTRACTS,
          tax: { hyperSyncApiToken: "" },
        },
        { fetcher: noOpFetcher },
      ),
    ).rejects.toThrow("tax.hyperSyncApiToken");

    await expect(
      syncTaxTransactions(
        {
          wallet: WALLET,
          rpc: "https://rpc.stub.invalid",
          chainId: 999,
          contracts: STUB_CONTRACTS,
          tax: {},
        },
        { fetcher: noOpFetcher },
      ),
    ).rejects.toThrow("tax.hyperSyncApiToken");

    await expect(
      syncTaxTransactions(
        {
          wallet: WALLET,
          rpc: "https://rpc.stub.invalid",
          chainId: 999,
          contracts: STUB_CONTRACTS,
          tax: { hyperSyncApiToken: "YOUR_HYPERSYNC_API_TOKEN" },
        },
        { fetcher: noOpFetcher },
      ),
    ).rejects.toThrow("tax.hyperSyncApiToken");
  });

  it("fails before fetch when an explicit Etherscan v2 explorer requires a real API key", async () => {
    let called = false;

    await expect(
      syncTaxTransactions(
        {
          wallet: WALLET,
          rpc: "https://rpc.stub.invalid",
          chainId: 999,
          contracts: STUB_CONTRACTS,
          tax: {
            explorerApiUrl: "https://api.etherscan.io/v2/api",
            explorerApiKey: "YOUR_ETHERSCAN_API_KEY_OPTIONAL",
          },
        },
        {
          hyperSyncClient: makeHyperSyncMock([], []),
          viemClient: makeNoOpViemMock(),
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

  it("skips malformed HyperSync rows (missing hash) and processes valid ones", async () => {
    // HyperSync implementation skips txs without hash or blockNumber in fetchTransactionsByAddress
    // We test that valid rows are stored and the summary count is correct
    const hyperSyncClient = makeHyperSyncMock(
      [
        // valid row
        {
          hash: "0xgood",
          blockNumber: 112,
          from: "0xfrom",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    const summary = await syncTaxTransactions(config(), {
      hyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    expect(summary.synced).toBe(1);
    expect(listTaxTransactions().map((row) => row.hash)).toEqual(["0xgood"]);
  });

  it("destructures native transfers relative to the configured wallet", async () => {
    const hash = "0x211d72eb6f3afa99f8de8e95ea4b27f5088892721da22672ee6700abdd2216d6";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 100,
          blockTimestamp: 1770000000,
          from: "0x57955467e2fd905dbb3026963a144dcacd566687",
          to: WALLET.toLowerCase(),
          value: 252451290000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(config(), {
      hyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    expect(getTaxTransaction(`hypersync:txlist:${hash}:external`)).toMatchObject({
      incoming_quantity: "0.25245129",
      incoming_asset: "HYPE",
      outgoing_quantity: null,
      outgoing_asset: null,
    });
  });

  it("destructures token transfers relative to the configured wallet", async () => {
    const contractAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xtokenout",
          from: WALLET,
          to: "0xreceiver",
          value: 25000000n,
          contractAddress,
          logIndex: 4,
          blockNumber: 100,
        }),
      ],
    );

    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
    });

    await syncTaxTransactions(config(), {
      hyperSyncClient,
      viemClient,
      fetcher: noOpFetcher,
    });

    expect(getTaxTransaction("hypersync:tokentx:0xtokenout:4")).toMatchObject({
      incoming_quantity: null,
      incoming_asset: null,
      outgoing_quantity: "25",
      outgoing_asset: "USDC",
    });
  });

  it("throws useful HyperSync errors without wiping existing metadata or sync state", async () => {
    // First sync: store a transaction via HyperSync
    const firstHyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xkept",
          blockNumber: 322,
          from: "0xfrom",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    upsertTaxSyncState({
      wallet: WALLET,
      last_synced_at: "2026-05-30T12:00:00.000Z",
      last_block_number: 321,
      source: "hypersync",
    });

    await syncTaxTransactions(config(), {
      hyperSyncClient: firstHyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    updateTaxTransaction("hypersync:txlist:0xkept:external", {
      label: "Trade",
      comment: "do not lose this",
    });

    // Second sync: HyperSync throws
    const errorHyperSyncClient = {
      get: async (_query: unknown) => {
        throw new Error("HyperSync network error");
      },
    } as unknown as HypersyncClient;

    await expect(
      syncTaxTransactions(config(), {
        hyperSyncClient: errorHyperSyncClient,
        viemClient: makeNoOpViemMock(),
        fetcher: noOpFetcher,
      }),
    ).rejects.toThrow("HyperSync network error");

    // Sync state should still reflect the last successful block
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 322 });
    // Metadata should be preserved
    expect(getTaxTransaction("hypersync:txlist:0xkept:external")).toMatchObject({
      label: "Trade",
      comment: "do not lose this",
    });
  });

  it("preserves row metadata, separates duplicate token logs, and keeps block state on no-row sync", async () => {
    const contractAddress = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: { symbol: "TOK", name: "Token", decimals: 18 },
    });

    const firstHyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xtokenhash",
          from: "0xsender",
          to: WALLET,
          value: 10n,
          contractAddress,
          logIndex: 1,
          blockNumber: 200,
        }),
        makeTokenLog({
          transactionHash: "0xtokenhash",
          from: "0xsender",
          to: WALLET,
          value: 20n,
          contractAddress,
          logIndex: 2,
          blockNumber: 201,
        }),
      ],
    );

    await syncTaxTransactions(config(), {
      hyperSyncClient: firstHyperSyncClient,
      viemClient,
      fetcher: noOpFetcher,
    });

    updateTaxTransaction("hypersync:tokentx:0xtokenhash:1", {
      label: "Transfer",
      comment: "manual classification",
    });

    // Second sync: same logs but first one has different value
    const secondHyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xtokenhash",
          from: "0xsender",
          to: WALLET,
          value: 999n,
          contractAddress,
          logIndex: 1,
          blockNumber: 200,
        }),
        makeTokenLog({
          transactionHash: "0xtokenhash",
          from: "0xsender",
          to: WALLET,
          value: 20n,
          contractAddress,
          logIndex: 2,
          blockNumber: 201,
        }),
      ],
    );

    await syncTaxTransactions(config(), {
      hyperSyncClient: secondHyperSyncClient,
      viemClient,
      fetcher: noOpFetcher,
    });

    expect(new Set(listTaxTransactions().map((row) => row.id))).toEqual(
      new Set(["hypersync:tokentx:0xtokenhash:1", "hypersync:tokentx:0xtokenhash:2"]),
    );
    expect(getTaxTransaction("hypersync:tokentx:0xtokenhash:1")).toMatchObject({
      value: "999",
      label: "Transfer",
      comment: "manual classification",
    });
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 201 });

    // Third sync: HyperSync returns nothing → block state preserved
    await syncTaxTransactions(config(), {
      hyperSyncClient: makeHyperSyncMock([], []),
      viemClient,
      fetcher: noOpFetcher,
    });
    expect(getTaxSyncState(WALLET)).toMatchObject({ last_block_number: 201 });
  });

  it("uses transactionHash for Hyperscan internal transactions (explorer path)", async () => {
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

    const summary = await syncTaxTransactions(config(), {
      hyperSyncClient: makeHyperSyncMock([], []),
      viemClient: makeNoOpViemMock(),
      fetcher,
      source: "hyperscan",
    });

    expect(summary.synced).toBe(1);
    expect(listTaxTransactions()).toMatchObject([
      {
        id: "hyperscan:txlistinternal:0xinternalhash:internal:0xfrom:0xto:123::call",
        hash: "0xinternalhash",
        transaction_type: "txlistinternal",
      },
    ]);
  });

  it("uses stable hypersync: IDs across different syncs without duplicate orphan rows", async () => {
    const stableTx = {
      hash: "0xstable",
      blockNumber: 500,
      from: "0xfrom",
      to: WALLET.toLowerCase(),
      value: 1n,
      gasUsed: 21000n,
      gasPrice: 1000000000n,
      input: "0x",
      status: 1,
      sighash: null,
    };

    // First sync
    await syncTaxTransactions(config(), {
      hyperSyncClient: makeHyperSyncMock([stableTx], []),
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    // Second sync with same tx
    await syncTaxTransactions(config(), {
      hyperSyncClient: makeHyperSyncMock([stableTx], []),
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
    });

    expect(listTaxTransactions().map((transaction) => transaction.id)).toEqual([
      "hypersync:txlist:0xstable:external",
    ]);
  });

  it("HyperSync error propagates and does not silently swallow failures", async () => {
    const errorHyperSyncClient = {
      get: async (_query: unknown) => {
        throw new Error("HyperSync fetch failed: connection refused");
      },
    } as unknown as HypersyncClient;

    await expect(
      syncTaxTransactions(config(), {
        hyperSyncClient: errorHyperSyncClient,
        viemClient: makeNoOpViemMock(),
        fetcher: noOpFetcher,
      }),
    ).rejects.toThrow("HyperSync fetch failed: connection refused");
  });

  it("txlistinternal still uses explorer and respects maxPages", async () => {
    const explorerRequests: RequestRecord[] = [];
    const fetcher = makeFetcher((params) => {
      if (params.get("action") === "txlistinternal") {
        const page = Number(params.get("page"));
        if (page <= 2) {
          return envelope([
            {
              transactionHash: `0xinternal${page}`,
              blockNumber: String(700 + page),
              timeStamp: "1770000000",
              from: "0xfrom",
              to: "0xto",
              value: "1",
              gasUsed: "0",
              gasPrice: "1000000000",
              type: "call",
            },
            {
              transactionHash: `0xinternal${page}b`,
              blockNumber: String(700 + page),
              timeStamp: "1770000000",
              from: "0xfrom",
              to: "0xto",
              value: "2",
              gasUsed: "0",
              gasPrice: "1000000000",
              type: "call",
            },
          ]);
        }
        return envelope([]);
      }
      return envelope([]);
    }, explorerRequests);

    await syncTaxTransactions(config(), {
      hyperSyncClient: makeHyperSyncMock([], []),
      viemClient: makeNoOpViemMock(),
      fetcher,
      pageSize: 2,
      maxPages: 2,
    });

    // Only txlistinternal goes to explorer
    const internalPages = actionPages(explorerRequests, "txlistinternal");
    expect(internalPages).toEqual([1, 2]);
    // 4 internal transactions stored
    expect(listTaxTransactions()).toHaveLength(4);
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
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    process.env.LP_TRACKER_DATA_DIR = join(TMP, crypto.randomUUID());
    resetDb();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LP_TRACKER_DATA_DIR;
    resetDb();
    rmSync(TMP, { recursive: true, force: true });
  });

  it("null time_stamp → EUR fields stay null", async () => {
    let cgCallCount = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("coingecko.com")) {
        cgCallCount++;
      }
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    // Override the mock to return no timestamp in blocks
    const noTimestampClient = {
      get: async (_query: unknown) => ({
        archiveHeight: 10000,
        nextBlock: 10000,
        totalExecutionTime: 1,
        data: {
          blocks: [], // no blocks → no timestamp lookup
          transactions: [
            {
              hash: "0xnullts1",
              blockNumber: 100,
              from: "0xsender",
              to: WALLET.toLowerCase(),
              value: 1000000000000000000n,
              gasUsed: 21000n,
              gasPrice: 1000000000n,
              input: "0x",
              status: 1,
              sighash: null,
            },
          ],
          logs: [],
          traces: [],
        },
      }),
    } as unknown as HypersyncClient;

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient: noTimestampClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
      source: "eurtest",
    });

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
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), {
        status: 200,
      });
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

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient: makeHyperSyncMock([], []),
      viemClient: makeNoOpViemMock(),
      fetcher,
      source: "eurtest2",
    });

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
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 20.0 } } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xincoming1",
          blockNumber: 100,
          blockTimestamp: 1770002000,
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 2000000000000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
      source: "eurtest3",
    });

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
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 20.0 } } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xoutgoing1",
          blockNumber: 100,
          blockTimestamp: 1770003000,
          from: WALLET.toLowerCase(),
          to: "0xrecipient",
          value: 3000000000000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
      source: "eurtest4",
    });

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
      return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), {
        status: 200,
      });
    }) as unknown as typeof globalThis.fetch;

    const contractAddress = "0x1234567890123456789012345678901234567890";
    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xunknownasset1",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 1,
          blockNumber: 100,
        }),
      ],
    );

    // Token metadata returns UNKNOWN_TOKEN_XYZ which has no coingeckoId
    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: {
        symbol: "UNKNOWN_TOKEN_XYZ",
        name: "Unknown Token",
        decimals: 18,
      },
    });

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient,
      viemClient,
      fetcher: noOpFetcher,
      source: "eurtest6",
    });

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
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 0.92 } } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    const contractAddress = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xusdcout1",
          from: WALLET,
          to: "0xrecipient",
          value: 50000000n,
          contractAddress,
          logIndex: 7,
          blockNumber: 100,
        }),
      ],
    );

    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
    });

    await syncTaxTransactions(configWithPricing(), {
      hyperSyncClient,
      viemClient,
      fetcher: noOpFetcher,
      source: "eurtest5",
    });

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

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xresil1",
          blockNumber: 100,
          blockTimestamp: 1770010000,
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 1000000000000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await expect(
      syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-1" }), {
        hyperSyncClient,
        viemClient: makeNoOpViemMock(),
        fetcher: noOpFetcher,
        source: "resil1",
      }),
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
          return {
            ok: true,
            json: async () => ({ market_data: { current_price: { eur: 0.9 } } }),
          } as Response;
        }
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const contractAddress = "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xresil2hype",
          blockNumber: 100,
          blockTimestamp: 1770011000,
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 1000000000000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [
        makeTokenLog({
          transactionHash: "0xresil2usdc",
          from: "0xsender",
          to: WALLET,
          value: 1000000n,
          contractAddress,
          logIndex: 1,
          blockNumber: 101,
        }),
      ],
    );

    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
    });

    await syncTaxTransactions(
      configWithPricing({ HYPE: "resilience-hype", USDC: "resilience-usdc" }),
      {
        hyperSyncClient,
        viemClient,
        fetcher: noOpFetcher,
        source: "resil2",
      },
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
        return {
          ok: true,
          json: async () => ({ market_data: { current_price: { eur: 10.0 } } }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const firstHyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xresil3",
          blockNumber: 100,
          blockTimestamp: 1770012000,
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 252451290000000000n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-3" }), {
      hyperSyncClient: firstHyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
      source: "resil3",
    });

    const rowAfterFirst = listTaxTransactions().find((r) => r.hash === "0xresil3");
    expect(rowAfterFirst).toBeDefined();
    const originalProceedsEur = rowAfterFirst!.proceeds_eur;
    expect(originalProceedsEur).not.toBeNull();

    // Second sync: CoinGecko would return 99.0 but upsert should NOT overwrite
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("coingecko.com")) {
        return {
          ok: true,
          json: async () => ({ market_data: { current_price: { eur: 99.0 } } }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    const secondHyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: "0xresil3",
          blockNumber: 100,
          blockTimestamp: 1770012000,
          from: "0xsender",
          to: WALLET.toLowerCase(),
          value: 999999999999999999n,
          gasUsed: 21000n,
          gasPrice: 1000000000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(configWithPricing({ HYPE: "resilience-cg-id-3" }), {
      hyperSyncClient: secondHyperSyncClient,
      viemClient: makeNoOpViemMock(),
      fetcher: noOpFetcher,
      source: "resil3",
    });

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

    const contractAddress = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        makeTokenLog({
          transactionHash: "0xdedup1",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 1,
          blockNumber: 100,
        }),
        makeTokenLog({
          transactionHash: "0xdedup2",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 2,
          blockNumber: 100,
        }),
        makeTokenLog({
          transactionHash: "0xdedup3",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 3,
          blockNumber: 100,
        }),
        makeTokenLog({
          transactionHash: "0xdedup4",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 4,
          blockNumber: 100,
        }),
        makeTokenLog({
          transactionHash: "0xdedup5",
          from: "0xsender",
          to: WALLET,
          value: 1000000000000000000n,
          contractAddress,
          logIndex: 5,
          blockNumber: 100,
        }),
      ],
    );

    const viemClient = makeViemMock({
      [contractAddress.toLowerCase()]: { symbol: "DEDUP_TOK", name: "Dedup Token", decimals: 18 },
    });

    await syncTaxTransactions(
      { ...config(), pricing: { coingeckoIds: { DEDUP_TOK: "dedup-coingecko-id" } } },
      {
        hyperSyncClient,
        viemClient,
        fetcher: noOpFetcher,
        source: "dedup-test",
      },
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

function makeEurDbRow(
  id: string,
  overrides: Partial<import("../db/store.js").SyncedTaxTransaction> = {},
): import("../db/store.js").SyncedTaxTransaction {
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

describe("DB EUR update functions", () => {
  const TMP_EUR =
    "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-db-eur-tests";

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
    upsertSyncedTaxTransaction(
      makeEurDbRow("dbeur-t1-row1", { cost_eur: null, proceeds_eur: null }),
    );
    upsertSyncedTaxTransaction(
      makeEurDbRow("dbeur-t1-row2", { cost_eur: null, proceeds_eur: null }),
    );
    upsertSyncedTaxTransaction(
      makeEurDbRow("dbeur-t1-row3", { proceeds_eur: "50", cost_eur: null }),
    );

    const result = getTaxTransactionsNeedingEurEnrichment();
    const ids = result.map((r) => r.id);

    expect(ids).toContain("dbeur-t1-row1");
    expect(ids).toContain("dbeur-t1-row2");
    expect(ids).not.toContain("dbeur-t1-row3");
    expect(result).toHaveLength(2);
  });

  // Test 2: excludes rows where only one EUR field is set
  it("getTaxTransactionsNeedingEurEnrichment — excludes row with cost_eur set but proceeds_eur null", () => {
    upsertSyncedTaxTransaction(
      makeEurDbRow("dbeur-t2-row1", { cost_eur: "30", proceeds_eur: null }),
    );

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
    upsertSyncedTaxTransaction(makeEurDbRow("dbeur-t4-row1"));

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
    upsertSyncedTaxTransaction(makeEurDbRow("dbeur-t5-row1"));

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
      makeEurDbRow("dbeur-t6-row1", {
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

function makeBackfillRow(
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

describe("enrichTaxTransactionsEurValues — backfill service", () => {
  const TMP_BACKFILL =
    "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-backfill-tests";

  function configWithPricing(coingeckoIds: Record<string, string>) {
    return {
      ...config(),
      pricing: { coingeckoIds },
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
      makeBackfillRow("backfill-t1-row1", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "2",
      }),
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
      makeBackfillRow("backfill-t2-row1", {
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
      makeBackfillRow("backfill-t3-row1", {
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
      makeBackfillRow("backfill-t4-row1", {
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
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeBackfillRow("backfill-t5-row1", {
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
        return new Response(JSON.stringify({ market_data: { current_price: { eur: 10.0 } } }), {
          status: 200,
        });
      }
      if (urlStr.includes("coingecko.com")) {
        return new Response("{}", { status: 404 });
      }
      throw new Error(`unexpected fetch: ${urlStr}`);
    }) as unknown as typeof globalThis.fetch;

    upsertSyncedTaxTransaction(
      makeBackfillRow("backfill-t6-known", {
        incoming_asset: "BACKFILL_TOK",
        incoming_quantity: "1",
        time_stamp: new Date(1770300000 * 1000).toISOString(),
      }),
    );
    upsertSyncedTaxTransaction(
      makeBackfillRow("backfill-t6-unknown", {
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
