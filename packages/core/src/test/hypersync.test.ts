import { describe, expect, it } from "bun:test";

import {
  fetchTokenTransfersByAddress,
  fetchTransactionsByAddress,
  padAddress,
} from "../chain/hypersync.js";
import type { HypersyncClient } from "@envio-dev/hypersync-client";

// ---------------------------------------------------------------------------
// Types mirroring the SDK shapes we need for mocking
// ---------------------------------------------------------------------------

interface MockBlock {
  number?: number;
  timestamp?: number;
}

interface MockTransaction {
  hash?: string;
  blockNumber?: number;
  from?: string;
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
  transactionHash?: string;
  blockNumber?: number;
  logIndex?: number;
  address?: string;
  data?: string;
  topics: (string | null | undefined)[];
}

interface MockQueryResponse {
  archiveHeight?: number;
  nextBlock: number;
  totalExecutionTime: number;
  data: {
    blocks: MockBlock[];
    transactions: MockTransaction[];
    logs: MockLog[];
    traces: unknown[];
  };
  rollbackGuard?: unknown;
}

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(responses: MockQueryResponse[]): HypersyncClient {
  let callCount = 0;
  return {
    get: async (_query: unknown) => {
      const resp = responses[callCount++];
      if (!resp) throw new Error("Unexpected extra call to client.get()");
      return resp;
    },
  } as unknown as HypersyncClient;
}

// ---------------------------------------------------------------------------
// Helpers for building mock data
// ---------------------------------------------------------------------------

const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12";
const WALLET_LOWER = WALLET.toLowerCase();
const ERC20_TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function makeTx(overrides: Partial<MockTransaction> = {}): MockTransaction {
  return {
    hash: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
    blockNumber: 100,
    from: WALLET_LOWER,
    to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    value: 1_000_000_000_000_000_000n,
    gasUsed: 21_000n,
    gasPrice: 1_000_000_000n,
    effectiveGasPrice: undefined,
    input: "0x",
    status: 1,
    sighash: null,
    ...overrides,
  };
}

function makeLog(overrides: Partial<MockLog> = {}): MockLog {
  const paddedWallet = padAddress(WALLET);
  const paddedOther = padAddress("0x1111111111111111111111111111111111111111");
  return {
    transactionHash: "0xbbbb000000000000000000000000000000000000000000000000000000000001",
    blockNumber: 200,
    logIndex: 0,
    address: "0xtoken000000000000000000000000000000000000",
    data: "0x" + "0".repeat(63) + "a", // value = 10n
    topics: [
      ERC20_TRANSFER_TOPIC0,
      paddedWallet, // from = wallet
      paddedOther,  // to = other
    ],
    ...overrides,
  };
}

function singlePageTxResponse(
  txs: MockTransaction[],
  blocks: MockBlock[] = [],
  archiveHeight = 1000,
): MockQueryResponse {
  return {
    archiveHeight,
    nextBlock: archiveHeight, // nextBlock >= archiveHeight → terminates
    totalExecutionTime: 1,
    data: { blocks, transactions: txs, logs: [], traces: [] },
  };
}

function singlePageLogResponse(
  logs: MockLog[],
  blocks: MockBlock[] = [],
  archiveHeight = 1000,
): MockQueryResponse {
  return {
    archiveHeight,
    nextBlock: archiveHeight,
    totalExecutionTime: 1,
    data: { blocks, transactions: [], logs, traces: [] },
  };
}

// ===========================================================================
// Suite 1: padAddress
// ===========================================================================

describe("padAddress", () => {
  it("pads a lowercase address correctly (24 zeros + 40 hex chars)", () => {
    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = padAddress(addr);
    expect(result).toBe("0x" + "0".repeat(24) + "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("pads a checksummed (mixed-case) address — result is lowercase", () => {
    const addr = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
    const result = padAddress(addr);
    expect(result).toBe("0x" + "0".repeat(24) + "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("handles address without 0x prefix", () => {
    const addr = "abcdef1234567890abcdef1234567890abcdef12";
    const result = padAddress(addr);
    expect(result).toBe("0x" + "0".repeat(24) + "abcdef1234567890abcdef1234567890abcdef12");
  });

  it("handles address with 0x prefix", () => {
    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = padAddress(addr);
    expect(result.startsWith("0x")).toBe(true);
    expect(result.slice(2, 26)).toBe("0".repeat(24));
  });

  it("result is always 66 chars total (0x + 64 hex)", () => {
    const addr = "0xabcdef1234567890abcdef1234567890abcdef12";
    const result = padAddress(addr);
    expect(result.length).toBe(66);
  });
});

// ===========================================================================
// Suite 2: fetchTransactionsByAddress — pagination
// ===========================================================================

describe("fetchTransactionsByAddress — pagination", () => {
  it("single page: nextBlock >= archiveHeight → returns results, no second call", async () => {
    const tx1 = makeTx();
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
    expect(results[0].hash).toBe(tx1.hash!.toLowerCase());
  });

  it("multi-page: exactly two calls made, results from both pages combined", async () => {
    const tx1 = makeTx({ hash: "0xaaaa000000000000000000000000000000000000000000000000000000000001" });
    const tx2 = makeTx({ hash: "0xaaaa000000000000000000000000000000000000000000000000000000000002" });

    const page1: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 500, // < archiveHeight → continue
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [tx1], logs: [], traces: [] },
    };
    const page2: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 1000, // >= archiveHeight → stop
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [tx2], logs: [], traces: [] },
    };

    let callCount = 0;
    const client = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) return page1;
        if (callCount === 2) return page2;
        throw new Error("Unexpected third call to client.get()");
      },
    } as unknown as HypersyncClient;

    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(callCount).toBe(2); // exactly two pages fetched
    expect(results).toHaveLength(2);
    const hashes = results.map((r) => r.hash);
    expect(hashes).toContain(tx1.hash!.toLowerCase());
    expect(hashes).toContain(tx2.hash!.toLowerCase());
  });

  it("empty first page: returns empty array, loop terminates", async () => {
    const client = mockClient([singlePageTxResponse([])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(0);
  });

  it("SDK throws on second call: error propagates", async () => {
    const tx1 = makeTx();
    const page1: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [tx1], logs: [], traces: [] },
    };
    let callCount = 0;
    const client = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) return page1;
        throw new Error("network error");
      },
    } as unknown as HypersyncClient;

    await expect(fetchTransactionsByAddress(client, WALLET, 0)).rejects.toThrow("network error");
  });

  it("toBlock respected: loop terminates when nextBlock >= toBlock", async () => {
    const tx1 = makeTx();
    const page: MockQueryResponse = {
      archiveHeight: 10_000,
      nextBlock: 500, // >= toBlock=500 → stop
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [tx1], logs: [], traces: [] },
    };
    const client = mockClient([page]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0, 500);
    expect(results).toHaveLength(1);
  });

  it("no archiveHeight, no toBlock: terminates after first page", async () => {
    const tx1 = makeTx();
    const page: MockQueryResponse = {
      // archiveHeight absent
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [tx1], logs: [], traces: [] },
    };
    const client = mockClient([page]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
  });
});

// ===========================================================================
// Suite 3: fetchTransactionsByAddress — normalization and deduplication
// ===========================================================================

describe("fetchTransactionsByAddress — normalization and deduplication", () => {
  it("self-transfer deduplication: same hash appears twice → only one entry", async () => {
    const hash = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
    // Both from and to match wallet — SDK may return same tx twice
    const tx1 = makeTx({ hash, from: WALLET_LOWER, to: WALLET_LOWER });
    const tx2 = makeTx({ hash, from: WALLET_LOWER, to: WALLET_LOWER });
    const client = mockClient([singlePageTxResponse([tx1, tx2])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
  });

  it("address lowercasing: from and to are lowercase", async () => {
    const tx1 = makeTx({
      from: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
      to: "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF",
    });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results[0].from).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(results[0].to).toBe("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("effectiveGasPrice preferred over gasPrice when both present", async () => {
    const tx1 = makeTx({
      gasPrice: 1_000_000_000n,
      effectiveGasPrice: 2_000_000_000n,
    });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results[0].gasPrice).toBe(2_000_000_000n);
  });

  it("gasPrice fallback: when effectiveGasPrice absent, gasPrice is used", async () => {
    const tx1 = makeTx({
      gasPrice: 1_500_000_000n,
      effectiveGasPrice: undefined,
    });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results[0].gasPrice).toBe(1_500_000_000n);
  });

  it("pending tx skipped: tx with blockNumber === undefined not included", async () => {
    const tx1 = makeTx({ blockNumber: undefined });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(0);
  });

  it("block timestamp joined: blockTimestamp populated from matching block", async () => {
    const tx1 = makeTx({ blockNumber: 100 });
    const block: MockBlock = { number: 100, timestamp: 1_770_000_000 };
    const client = mockClient([singlePageTxResponse([tx1], [block])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results[0].blockTimestamp).toBe(1_770_000_000);
  });

  it("status=0 (failed tx) included in output", async () => {
    const tx1 = makeTx({ status: 0 });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe(0);
  });

  it("to=null for contract creation: tx.to undefined → HyperSyncTransaction.to is null", async () => {
    const tx1 = makeTx({ to: undefined });
    const client = mockClient([singlePageTxResponse([tx1])]);
    const results = await fetchTransactionsByAddress(client, WALLET, 0);
    expect(results[0].to).toBeNull();
  });
});

// ===========================================================================
// Suite 4: fetchTokenTransfersByAddress — pagination
// ===========================================================================

describe("fetchTokenTransfersByAddress — pagination", () => {
  it("single page: nextBlock >= archiveHeight → returns results, no second call", async () => {
    const log1 = makeLog();
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
  });

  it("multi-page: exactly two calls made, results from both pages combined", async () => {
    const log1 = makeLog({ transactionHash: "0xbbbb000000000000000000000000000000000000000000000000000000000001", logIndex: 0 });
    const log2 = makeLog({ transactionHash: "0xbbbb000000000000000000000000000000000000000000000000000000000002", logIndex: 0 });

    const page1: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [], logs: [log1], traces: [] },
    };
    const page2: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 1000,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [], logs: [log2], traces: [] },
    };

    let callCount = 0;
    const client = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) return page1;
        if (callCount === 2) return page2;
        throw new Error("Unexpected third call to client.get()");
      },
    } as unknown as HypersyncClient;

    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(callCount).toBe(2); // exactly two pages fetched
    expect(results).toHaveLength(2);
  });

  it("empty first page: returns empty array, loop terminates", async () => {
    const client = mockClient([singlePageLogResponse([])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(0);
  });

  it("SDK throws on second call: error propagates", async () => {
    const log1 = makeLog();
    const page1: MockQueryResponse = {
      archiveHeight: 1000,
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [], logs: [log1], traces: [] },
    };
    let callCount = 0;
    const client = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) return page1;
        throw new Error("network error");
      },
    } as unknown as HypersyncClient;

    await expect(fetchTokenTransfersByAddress(client, WALLET, 0)).rejects.toThrow("network error");
  });

  it("toBlock respected: loop terminates when nextBlock >= toBlock", async () => {
    const log1 = makeLog();
    const page: MockQueryResponse = {
      archiveHeight: 10_000,
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [], logs: [log1], traces: [] },
    };
    const client = mockClient([page]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0, 500);
    expect(results).toHaveLength(1);
  });

  it("no archiveHeight, no toBlock: terminates after first page", async () => {
    const log1 = makeLog();
    const page: MockQueryResponse = {
      nextBlock: 500,
      totalExecutionTime: 1,
      data: { blocks: [], transactions: [], logs: [log1], traces: [] },
    };
    const client = mockClient([page]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
  });
});

// ===========================================================================
// Suite 5: fetchTokenTransfersByAddress — normalization and deduplication
// ===========================================================================

describe("fetchTokenTransfersByAddress — normalization and deduplication", () => {
  it("ERC-20 value parsing: data = 0x + 64-char hex uint256 → correct bigint value", async () => {
    // value = 1000000000000000000 = 0xde0b6b3a7640000
    const hexVal = "0000000000000000000000000000000000000000000000000de0b6b3a7640000";
    const log1 = makeLog({ data: "0x" + hexVal });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].value).toBe(1_000_000_000_000_000_000n);
    expect(results[0].isNft).toBe(false);
  });

  it("ERC-721 detection: data = '0x' → value=1n, isNft=true", async () => {
    const log1 = makeLog({ data: "0x" });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].value).toBe(1n);
    expect(results[0].isNft).toBe(true);
  });

  it("ERC-721 detection: data = '' → value=1n, isNft=true", async () => {
    const log1 = makeLog({ data: "" });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].value).toBe(1n);
    expect(results[0].isNft).toBe(true);
  });

  it("ERC-20 detection: data has content → isNft=false", async () => {
    const log1 = makeLog({ data: "0x" + "0".repeat(63) + "1" });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].isNft).toBe(false);
  });

  it("address extraction from topics: topic1/topic2 are 32-byte padded → correct 20-byte addresses", async () => {
    const fromAddr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const toAddr = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const log1 = makeLog({
      topics: [
        ERC20_TRANSFER_TOPIC0,
        padAddress(fromAddr),
        padAddress(toAddr),
      ],
    });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].from).toBe(fromAddr.toLowerCase());
    expect(results[0].to).toBe(toAddr.toLowerCase());
  });

  it("deduplication by txHash+logIndex: same log appears twice → only one entry", async () => {
    const log1 = makeLog();
    const log2 = makeLog(); // identical transactionHash and logIndex
    const client = mockClient([singlePageLogResponse([log1, log2])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(1);
  });

  it("log with undefined blockNumber skipped: not included in output", async () => {
    const log1 = makeLog({ blockNumber: undefined });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(0);
  });

  it("block timestamp joined: blockTimestamp populated from matching block", async () => {
    const log1 = makeLog({ blockNumber: 200 });
    const block: MockBlock = { number: 200, timestamp: 1_770_000_000 };
    const client = mockClient([singlePageLogResponse([log1], [block])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results[0].blockTimestamp).toBe(1_770_000_000);
  });

  it("log with missing transactionHash skipped: not included in output", async () => {
    const log1 = makeLog({ transactionHash: undefined });
    const client = mockClient([singlePageLogResponse([log1])]);
    const results = await fetchTokenTransfersByAddress(client, WALLET, 0);
    expect(results).toHaveLength(0);
  });
});
