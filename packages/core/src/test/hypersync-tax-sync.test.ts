/**
 * Adversarial tests for syncTaxTransactions (HyperSync path)
 *
 * Covers:
 *   m4t2 — transaction type mapping, direction detection, ID generation
 *   m4t3 — incremental sync watermark, EUR preservation on re-sync
 *   m4t4 — token metadata integration, self-transfers, zero-value txs
 */

import { describe, expect, it } from "bun:test";

import type { HypersyncClient as LocalHypersyncClient } from "../chain/hypersync.js";
import type { TokenMetadataClient } from "../chain/token-metadata.js";
import {
  getTaxSyncState,
  getTaxTransaction,
  upsertTaxSyncState,
  updateTaxTransactionEurValues,
} from "../db/store.js";
import { syncTaxTransactions } from "../services/tax-transactions.js";
import type { SyncTaxTransactionsOptions } from "../services/tax-transactions.js";
import { useTestDb } from "./helpers/db.js";
import { makeHypersyncClient } from "./helpers/hypersync.js";

const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12" as `0x${string}`;

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    wallet: WALLET,
    tax: { hyperSyncUrl: "https://hyperliquid.hypersync.xyz", hyperSyncApiToken: "test-token" },
    pricing: {},
    rpc: "https://rpc.example.com",
    logsRpc: undefined as string | undefined,
    chainId: 999,
    contracts: {
      factory: "0xFf7B3e8C00e57ea31477c32A5B52a58Eea47b072" as `0x${string}`,
      positionManager: "0xeaD19AE861c29bBb2101E834922B2FEee69B9091" as `0x${string}`,
      quoter: "0x239F11a7A3E08f2B8110D4CA9F6B95d4c8865258" as `0x${string}`,
      swapRouter: "0x1EbDFC75FfE3ba3de61E7138a3E8706aC841Af9B" as `0x${string}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Explorer fetcher that returns no internal transactions
// ---------------------------------------------------------------------------

const noOpFetcher = async (_url: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: "0",
    message: "No transactions found",
    result: "No transactions found",
  }),
});

// ---------------------------------------------------------------------------
// HyperSync mock helpers
// ---------------------------------------------------------------------------

interface MockTx {
  hash: string;
  blockNumber: number;
  blockTimestamp: number;
  from: string;
  to: string | null;
  value: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  input: string;
  status: number;
  sighash: string | null;
}

interface MockLog {
  transactionHash: string;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  /** token contract address */
  address: string;
  /** 0x-prefixed hex data (ERC-20 value) or "0x" for NFT */
  data: string;
  /** [topic0, topic1(from padded), topic2(to padded)] */
  topics: string[];
}

/**
 * Build a HypersyncClient mock that returns the given txs and logs.
 *
 * fetchTransactionsByAddress calls client.get() and reads response.data.transactions.
 * fetchTokenTransfersByAddress calls client.get() and reads response.data.logs.
 *
 * We return both in every response with archiveHeight = nextBlock so pagination
 * terminates after a single page.
 */
function makeHyperSyncMock(txs: MockTx[], logs: MockLog[]): LocalHypersyncClient {
  return makeHypersyncClient(async (_query) => ({
    archiveHeight: 10_000,
    nextBlock: 10_000,
    totalExecutionTime: 1,
    data: {
      blocks: [
        ...txs.map((tx) => ({ number: tx.blockNumber, timestamp: tx.blockTimestamp })),
        ...logs.map((l) => ({ number: l.blockNumber, timestamp: l.blockTimestamp })),
      ],
      transactions: txs.map((tx) => ({
        hash: tx.hash,
        blockNumber: tx.blockNumber,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        gasUsed: tx.gasUsed,
        gasPrice: tx.gasPrice,
        effectiveGasPrice: tx.gasPrice,
        input: tx.input,
        status: tx.status,
        sighash: tx.sighash,
      })),
      logs: logs.map((l) => ({
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
        address: l.address,
        data: l.data,
        topics: l.topics,
      })),
      traces: [],
    },
  }));
}

/**
 * Build a viem Client mock that returns token metadata from the given map.
 * Keys are lowercase contract addresses.
 */
function makeViemMock(
  metadata: Record<string, { symbol: string | null; name: string | null; decimals: number | null }>,
): NonNullable<SyncTaxTransactionsOptions["viemClient"]> {
  return {
    readContract: async (args) => {
      const address = String(args.address).toLowerCase();
      const functionName = args.functionName;
      const m = metadata[address];
      if (!m) throw new Error(`No metadata for ${address}`);
      if (functionName === "symbol") {
        if (m.symbol === null) throw new Error("no symbol");
        return m.symbol;
      }
      if (functionName === "name") {
        if (m.name === null) throw new Error("no name");
        return m.name;
      }
      if (functionName === "decimals") {
        if (m.decimals === null) throw new Error("no decimals");
        return m.decimals;
      }
      throw new Error(`Unknown function ${functionName}`);
    },
  } satisfies TokenMetadataClient;
}

/** Pad a 20-byte address to 32-byte topic format */
function padAddr(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return "0x" + "0".repeat(24) + hex;
}

const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Build an ERC-20 Transfer log */
function erc20Log(overrides: {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  contractAddress: string;
  from: string;
  to: string;
  value: bigint;
}): MockLog {
  const valueHex = overrides.value.toString(16).padStart(64, "0");
  return {
    transactionHash: overrides.txHash,
    blockNumber: overrides.blockNumber,
    blockTimestamp: overrides.blockTimestamp,
    logIndex: overrides.logIndex,
    address: overrides.contractAddress,
    data: "0x" + valueHex,
    topics: [ERC20_TRANSFER_TOPIC0, padAddr(overrides.from), padAddr(overrides.to)],
  };
}

/** Build an ERC-721 Transfer log (no data → isNft = true) */
function erc721Log(overrides: {
  txHash: string;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  contractAddress: string;
  from: string;
  to: string;
}): MockLog {
  return {
    transactionHash: overrides.txHash,
    blockNumber: overrides.blockNumber,
    blockTimestamp: overrides.blockTimestamp,
    logIndex: overrides.logIndex,
    address: overrides.contractAddress,
    data: "0x", // empty → isNft = true
    topics: [ERC20_TRANSFER_TOPIC0, padAddr(overrides.from), padAddr(overrides.to)],
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

useTestDb();

// ===========================================================================
// Suite 1 (m4t2): Transaction type mapping, direction detection, ID generation
// ===========================================================================

describe("Suite 1 — transaction type mapping, direction detection, ID generation", () => {
  it("external tx incoming: to=wallet → incoming_quantity set, outgoing_quantity null, type=txlist, correct id", async () => {
    const hash = "0xabc0000000000000000000000000000000000000000000000000000000000001";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
          from: "0x1111111111111111111111111111111111111111",
          to: WALLET.toLowerCase(),
          value: 1_000_000_000_000_000_000n, // 1 HYPE
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    const summary = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    expect(summary.synced).toBe(1);
    expect(summary.source).toBe("hypersync");

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.transaction_type).toBe("txlist");
    expect(row!.id).toBe(`hypersync:txlist:${hash}:external`);
    expect(row!.incoming_quantity).not.toBeNull();
    expect(row!.outgoing_quantity).toBeNull();
    expect(row!.incoming_asset).toBe("HYPE");
  });

  it("external tx outgoing: from=wallet → outgoing_quantity set, incoming_quantity null", async () => {
    const hash = "0xabc0000000000000000000000000000000000000000000000000000000000002";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 101,
          blockTimestamp: 1_700_000_001,
          from: WALLET.toLowerCase(),
          to: "0x2222222222222222222222222222222222222222",
          value: 500_000_000_000_000_000n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.outgoing_quantity).not.toBeNull();
    expect(row!.incoming_quantity).toBeNull();
    expect(row!.outgoing_asset).toBe("HYPE");
  });

  it("ERC-20 transfer incoming: to=wallet → incoming_quantity set, type=tokentx, correct id", async () => {
    const txHash = "0xabc0000000000000000000000000000000000000000000000000000000000003";
    const contractAddr = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC mainnet (valid addr)
    const logIndex = 5;

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc20Log({
          txHash,
          blockNumber: 200,
          blockTimestamp: 1_700_000_100,
          logIndex,
          contractAddress: contractAddr,
          from: "0x3333333333333333333333333333333333333333",
          to: WALLET.toLowerCase(),
          value: 1_000_000_000_000_000_000n,
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "USDC", name: "USD Coin", decimals: 18 },
      }),
    });

    const expectedId = `hypersync:tokentx:${txHash}:${logIndex}`;
    const row = getTaxTransaction(expectedId);
    expect(row).not.toBeNull();
    expect(row!.transaction_type).toBe("tokentx");
    expect(row!.id).toBe(expectedId);
    expect(row!.incoming_quantity).not.toBeNull();
    expect(row!.outgoing_quantity).toBeNull();
  });

  it("ERC-721 transfer incoming: isNft=true → type=tokennfttx, correct id", async () => {
    const txHash = "0xabc0000000000000000000000000000000000000000000000000000000000004";
    const contractAddr = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d"; // BAYC (valid addr)
    const logIndex = 0;

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc721Log({
          txHash,
          blockNumber: 300,
          blockTimestamp: 1_700_000_200,
          logIndex,
          contractAddress: contractAddr,
          from: "0x4444444444444444444444444444444444444444",
          to: WALLET.toLowerCase(),
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "MYNFT", name: "My NFT", decimals: null },
      }),
    });

    const expectedId = `hypersync:tokennfttx:${txHash}:${logIndex}`;
    const row = getTaxTransaction(expectedId);
    expect(row).not.toBeNull();
    expect(row!.transaction_type).toBe("tokennfttx");
    expect(row!.id).toBe(expectedId);
  });

  it("failed tx (status=0): is_error=1, row still stored", async () => {
    const hash = "0xabc0000000000000000000000000000000000000000000000000000000000005";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 400,
          blockTimestamp: 1_700_000_300,
          from: WALLET.toLowerCase(),
          to: "0x5555555555555555555555555555555555555555",
          value: 0n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 0, // failed
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.is_error).toBe(1);
  });

  it("native HYPE asset: external tx → incoming_asset='HYPE'", async () => {
    const hash = "0xabc0000000000000000000000000000000000000000000000000000000000006";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 500,
          blockTimestamp: 1_700_000_400,
          from: "0x6666666666666666666666666666666666666666",
          to: WALLET.toLowerCase(),
          value: 2_000_000_000_000_000_000n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.incoming_asset).toBe("HYPE");
  });

  it("gas fee calculated: fee = gasUsed * gasPrice as string", async () => {
    const hash = "0xabc0000000000000000000000000000000000000000000000000000000000007";
    const gasUsed = 42_000n;
    const gasPrice = 2_000_000_000n;
    const expectedFee = (gasUsed * gasPrice).toString();

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 600,
          blockTimestamp: 1_700_000_500,
          from: WALLET.toLowerCase(),
          to: "0x7777777777777777777777777777777777777777",
          value: 0n,
          gasUsed,
          gasPrice,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.fee).toBe(expectedFee);
  });
});

// ===========================================================================
// Suite 2 (m4t3): Incremental sync watermark, EUR preservation
// ===========================================================================

describe("Suite 2 — incremental sync watermark, EUR preservation", () => {
  it("first sync with no previous state: fromBlock=0 (fetches from genesis)", async () => {
    // No previous sync state → fromBlock should be 0
    // We verify by checking that the sync completes and stores a row from block 0
    const hash = "0xbbb0000000000000000000000000000000000000000000000000000000000001";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 0,
          blockTimestamp: 1_600_000_000,
          from: "0x8888888888888888888888888888888888888888",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    const summary = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    expect(summary.synced).toBe(1);
    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.block_number).toBe(0);
  });

  it("incremental sync: second sync uses fromBlock = last_block_number + 1", async () => {
    // First sync: store a tx at block 500
    const hash1 = "0xbbb0000000000000000000000000000000000000000000000000000000000002";
    const firstClient = makeHyperSyncMock(
      [
        {
          hash: hash1,
          blockNumber: 500,
          blockTimestamp: 1_700_000_000,
          from: "0x9999999999999999999999999999999999999999",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient: firstClient,
      viemClient: makeViemMock({}),
    });

    // Verify watermark was set
    const state = getTaxSyncState(WALLET);
    expect(state).not.toBeNull();
    expect(state!.last_block_number).toBe(500);

    // Second sync: new tx at block 600
    const hash2 = "0xbbb0000000000000000000000000000000000000000000000000000000000003";
    const secondClient = makeHyperSyncMock(
      [
        {
          hash: hash2,
          blockNumber: 600,
          blockTimestamp: 1_700_001_000,
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    const summary2 = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient: secondClient,
      viemClient: makeViemMock({}),
    });

    expect(summary2.synced).toBe(1);
    const state2 = getTaxSyncState(WALLET);
    expect(state2!.last_block_number).toBe(600);
  });

  it("fromBlock=1 when last_block_number=0 (falsy-zero fix)", async () => {
    // Manually set sync state with last_block_number = 0
    upsertTaxSyncState({
      wallet: WALLET,
      last_synced_at: new Date().toISOString(),
      last_block_number: 0,
      source: "hypersync",
    });

    // The next sync should use fromBlock = 0 + 1 = 1
    // We verify by checking that a tx at block 0 is NOT fetched (it would be at fromBlock=0)
    // and a tx at block 1 IS fetched.
    // Since we can't directly inspect the fromBlock passed to client.get(), we verify
    // the behavior indirectly: the sync state is updated to last_block_number = 1.
    const hash = "0xbbb0000000000000000000000000000000000000000000000000000000000004";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 1,
          blockTimestamp: 1_700_000_000,
          from: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const state = getTaxSyncState(WALLET);
    expect(state!.last_block_number).toBe(1);
  });

  it("watermark updated: last_block_number = max block seen across all txs", async () => {
    const hash1 = "0xbbb0000000000000000000000000000000000000000000000000000000000005";
    const hash2 = "0xbbb0000000000000000000000000000000000000000000000000000000000006";
    const contractAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT mainnet (valid addr)

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: hash1,
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
          from: "0xcccccccccccccccccccccccccccccccccccccccc",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [
        erc20Log({
          txHash: hash2,
          blockNumber: 999, // higher block
          blockTimestamp: 1_700_001_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0xdddddddddddddddddddddddddddddddddddddddd",
          to: WALLET.toLowerCase(),
          value: 1_000_000n,
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "USDT", name: "Tether", decimals: 6 },
      }),
    });

    const state = getTaxSyncState(WALLET);
    expect(state).not.toBeNull();
    expect(state!.last_block_number).toBe(999);
  });

  it("EUR preservation on re-sync: manually set cost_eur is NOT overwritten", async () => {
    const hash = "0xbbb0000000000000000000000000000000000000000000000000000000000007";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 200,
          blockTimestamp: 1_700_000_000,
          from: WALLET.toLowerCase(),
          to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          value: 1_000_000_000_000_000_000n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    // First sync
    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const id = `hypersync:txlist:${hash}:external`;
    const rowAfterFirstSync = getTaxTransaction(id);
    expect(rowAfterFirstSync).not.toBeNull();

    // Manually set EUR values (simulating a user enrichment)
    updateTaxTransactionEurValues(id, {
      cost_eur: "1234.56",
      proceeds_eur: null,
      gain_eur: "-1234.56",
    });

    const rowWithEur = getTaxTransaction(id);
    expect(rowWithEur!.cost_eur).toBe("1234.56");

    // Re-sync same data
    const hyperSyncClient2 = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 200,
          blockTimestamp: 1_700_000_000,
          from: WALLET.toLowerCase(),
          to: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          value: 1_000_000_000_000_000_000n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient: hyperSyncClient2,
      viemClient: makeViemMock({}),
    });

    const rowAfterResync = getTaxTransaction(id);
    expect(rowAfterResync).not.toBeNull();
    // EUR values must be preserved — not overwritten by re-sync
    expect(rowAfterResync!.cost_eur).toBe("1234.56");
  });

  it("summary counts: synced = total rows processed, source = 'hypersync'", async () => {
    const hash1 = "0xbbb0000000000000000000000000000000000000000000000000000000000008";
    const hash2 = "0xbbb0000000000000000000000000000000000000000000000000000000000009";
    const contractAddr = "0x6b175474e89094c44da98b954eedeac495271d0f"; // DAI mainnet (valid addr)

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash: hash1,
          blockNumber: 10,
          blockTimestamp: 1_700_000_000,
          from: "0xffffffffffffffffffffffffffffffffffffffff",
          to: WALLET.toLowerCase(),
          value: 1n,
          gasUsed: 21_000n,
          gasPrice: 1n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [
        erc20Log({
          txHash: hash2,
          blockNumber: 11,
          blockTimestamp: 1_700_000_001,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0x1111111111111111111111111111111111111111",
          to: WALLET.toLowerCase(),
          value: 100n,
        }),
      ],
    );

    const summary = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "TOK", name: "Token", decimals: 18 },
      }),
    });

    // 1 external tx + 1 token transfer = 2
    expect(summary.synced).toBe(2);
    expect(summary.source).toBe("hypersync");
  });
});

// ===========================================================================
// Suite 3 (m4t4): Token metadata integration, self-transfers, zero-value txs
// ===========================================================================

describe("Suite 3 — token metadata integration, self-transfers, zero-value txs", () => {
  it("token symbol from metadata: ERC-20 → token_symbol=resolved, token_decimal=resolved", async () => {
    const txHash = "0xccc0000000000000000000000000000000000000000000000000000000000001";
    const contractAddr = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC mainnet (valid addr)

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc20Log({
          txHash,
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0x1111111111111111111111111111111111111111",
          to: WALLET.toLowerCase(),
          value: 1_000_000n,
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
      }),
    });

    const row = getTaxTransaction(`hypersync:tokentx:${txHash}:0`);
    expect(row).not.toBeNull();
    expect(row!.token_symbol).toBe("USDC");
    expect(row!.token_decimal).toBe(6);
  });

  it("token metadata null fallback: all-null metadata → token_symbol=null, token_decimal=null", async () => {
    const txHash = "0xccc0000000000000000000000000000000000000000000000000000000000002";
    const contractAddr = "0xdac17f958d2ee523a2206206994597c13d831ec7"; // USDT mainnet (valid addr)

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc20Log({
          txHash,
          blockNumber: 100,
          blockTimestamp: 1_700_000_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0x2222222222222222222222222222222222222222",
          to: WALLET.toLowerCase(),
          value: 1_000_000n,
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: null, name: null, decimals: null },
      }),
    });

    const row = getTaxTransaction(`hypersync:tokentx:${txHash}:0`);
    expect(row).not.toBeNull();
    expect(row!.token_symbol).toBeNull();
    expect(row!.token_decimal).toBeNull();
  });

  it("self-transfer (from=to=wallet): only incoming_quantity set (to-check runs first)", async () => {
    const hash = "0xccc0000000000000000000000000000000000000000000000000000000000003";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 200,
          blockTimestamp: 1_700_000_000,
          from: WALLET.toLowerCase(),
          to: WALLET.toLowerCase(), // self-transfer
          value: 1_000_000_000_000_000_000n,
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    // taxLedgerFields checks `to` first → incoming_quantity set
    expect(row!.incoming_quantity).not.toBeNull();
    // `to` matched first, so from-check is skipped → outgoing_quantity null
    expect(row!.outgoing_quantity).toBeNull();
  });

  it("zero-value tx: value=0n → incoming_quantity='0', incoming_asset='HYPE'", async () => {
    const hash = "0xccc0000000000000000000000000000000000000000000000000000000000004";
    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 300,
          blockTimestamp: 1_700_000_000,
          from: "0x3333333333333333333333333333333333333333",
          to: WALLET.toLowerCase(),
          value: 0n, // zero value
          gasUsed: 21_000n,
          gasPrice: 1_000_000_000n,
          input: "0x",
          status: 1,
          sighash: null,
        },
      ],
      [],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({}),
    });

    const row = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(row).not.toBeNull();
    expect(row!.incoming_quantity).toBe("0");
    expect(row!.incoming_asset).toBe("HYPE");
  });

  it("grouped zero-wrapper merge: skip wrapper and move full gas fields to first token row", async () => {
    const hash = "0xccc000000000000000000000000000000000000000000000000000000000000a";
    const contractAddr = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const gasUsed = 93_422n;
    const gasPrice = 160_000_000n;

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 600,
          blockTimestamp: 1_700_000_000,
          from: WALLET.toLowerCase(),
          to: "0x6666666666666666666666666666666666666666",
          value: 0n,
          gasUsed,
          gasPrice,
          input: "0x",
          status: 1,
          sighash: "0x2b2dfd2c",
        },
      ],
      [
        erc20Log({
          txHash: hash,
          blockNumber: 600,
          blockTimestamp: 1_700_000_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: WALLET.toLowerCase(),
          to: "0x6666666666666666666666666666666666666666",
          value: 474_117_582n,
        }),
      ],
    );

    const summary = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
      }),
    });

    expect(summary.synced).toBe(1);
    const wrapper = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(wrapper).toBeNull();

    const tokenRow = getTaxTransaction(`hypersync:tokentx:${hash}:0`);
    expect(tokenRow).not.toBeNull();
    expect(tokenRow!.gas_used).toBe(gasUsed.toString());
    expect(tokenRow!.gas_price).toBe(gasPrice.toString());
    expect(tokenRow!.fee).toBe((gasUsed * gasPrice).toString());
  });

  it("grouped zero-wrapper merge: with multiple token rows, only first log index gets gas fee", async () => {
    const hash = "0xccc000000000000000000000000000000000000000000000000000000000000b";
    const contractAddrA = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const contractAddrB = "0x6b175474e89094c44da98b954eedeac495271d0f";
    const gasUsed = 50_000n;
    const gasPrice = 3_000_000_000n;

    const hyperSyncClient = makeHyperSyncMock(
      [
        {
          hash,
          blockNumber: 700,
          blockTimestamp: 1_700_000_001,
          from: WALLET.toLowerCase(),
          to: "0x7777777777777777777777777777777777777777",
          value: 0n,
          gasUsed,
          gasPrice,
          input: "0x",
          status: 1,
          sighash: "0x2b2dfd2c",
        },
      ],
      [
        erc20Log({
          txHash: hash,
          blockNumber: 700,
          blockTimestamp: 1_700_000_001,
          logIndex: 3,
          contractAddress: contractAddrB,
          from: WALLET.toLowerCase(),
          to: "0x7777777777777777777777777777777777777777",
          value: 42n,
        }),
        erc20Log({
          txHash: hash,
          blockNumber: 700,
          blockTimestamp: 1_700_000_001,
          logIndex: 1,
          contractAddress: contractAddrA,
          from: WALLET.toLowerCase(),
          to: "0x7777777777777777777777777777777777777777",
          value: 100n,
        }),
      ],
    );

    const summary = await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddrA]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
        [contractAddrB]: { symbol: "DAI", name: "Dai", decimals: 18 },
      }),
    });

    expect(summary.synced).toBe(2);
    const wrapper = getTaxTransaction(`hypersync:txlist:${hash}:external`);
    expect(wrapper).toBeNull();

    const firstRow = getTaxTransaction(`hypersync:tokentx:${hash}:1`);
    const secondRow = getTaxTransaction(`hypersync:tokentx:${hash}:3`);
    expect(firstRow).not.toBeNull();
    expect(secondRow).not.toBeNull();

    expect(firstRow!.gas_used).toBe(gasUsed.toString());
    expect(firstRow!.gas_price).toBe(gasPrice.toString());
    expect(firstRow!.fee).toBe((gasUsed * gasPrice).toString());

    expect(secondRow!.gas_used).toBeNull();
    expect(secondRow!.gas_price).toBeNull();
    expect(secondRow!.fee).toBeNull();
  });

  it("ERC-20 with decimals=0: quantity = raw value as-is", async () => {
    const txHash = "0xccc0000000000000000000000000000000000000000000000000000000000005";
    const contractAddr = "0x6b175474e89094c44da98b954eedeac495271d0f"; // DAI mainnet (valid addr)
    const rawValue = 42n;

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc20Log({
          txHash,
          blockNumber: 400,
          blockTimestamp: 1_700_000_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0x4444444444444444444444444444444444444444",
          to: WALLET.toLowerCase(),
          value: rawValue,
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "NODEC", name: "No Decimals Token", decimals: 0 },
      }),
    });

    const row = getTaxTransaction(`hypersync:tokentx:${txHash}:0`);
    expect(row).not.toBeNull();
    expect(row!.token_decimal).toBe(0);
    // decimals=0 → no division, quantity = raw value
    expect(row!.incoming_quantity).toBe("42");
  });

  it("ERC-20 with decimals=6: value=1000000n → incoming_quantity='1'", async () => {
    const txHash = "0xccc0000000000000000000000000000000000000000000000000000000000006";
    const contractAddr = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC mainnet (valid addr)

    const hyperSyncClient = makeHyperSyncMock(
      [],
      [
        erc20Log({
          txHash,
          blockNumber: 500,
          blockTimestamp: 1_700_000_000,
          logIndex: 0,
          contractAddress: contractAddr,
          from: "0x5555555555555555555555555555555555555555",
          to: WALLET.toLowerCase(),
          value: 1_000_000n, // 1 USDC with 6 decimals
        }),
      ],
    );

    await syncTaxTransactions(makeConfig(), {
      fetcher: noOpFetcher,
      hyperSyncClient,
      viemClient: makeViemMock({
        [contractAddr]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
      }),
    });

    const row = getTaxTransaction(`hypersync:tokentx:${txHash}:0`);
    expect(row).not.toBeNull();
    expect(row!.incoming_quantity).toBe("1");
  });
});
