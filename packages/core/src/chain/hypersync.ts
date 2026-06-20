import {
  HypersyncClient as HypersyncSdkClient,
  JoinMode,
  type Query,
  type BlockField,
  type ClientConfig,
  type FieldSelection,
  type LogField,
  type LogSelection,
  type TransactionField,
  type TransactionSelection,
} from "@envio-dev/hypersync-client";

export interface HypersyncQueryResponse {
  archiveHeight?: number;
  nextBlock: number;
  totalExecutionTime: number;
  data: {
    blocks: Array<{ number?: number; timestamp?: number }>;
    transactions: Array<{
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
    }>;
    logs: Array<{
      transactionHash?: string;
      blockNumber?: number;
      logIndex?: number;
      address?: string;
      data?: string;
      topics: Array<string | null | undefined>;
    }>;
    traces: unknown[];
  };
}

export interface HypersyncClient {
  get(query: Query): Promise<HypersyncQueryResponse>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_HYPERSYNC_URL = "https://hyperliquid.hypersync.xyz";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HyperSyncConfig {
  /** e.g. "https://hyperliquid.hypersync.xyz" */
  url: string;
  /** Required by HyperSync since Nov 2025 */
  apiToken: string;
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createHyperSyncClient(config: HyperSyncConfig): HypersyncClient {
  const cfg: ClientConfig = {
    url: config.url,
    apiToken: config.apiToken,
    httpReqTimeoutMillis: 30_000,
    maxNumRetries: 3,
  };
  return new HypersyncSdkClient(cfg);
}

// ---------------------------------------------------------------------------
// Normalised output types
// ---------------------------------------------------------------------------

export interface HyperSyncTransaction {
  hash: string;
  blockNumber: number;
  /** From joined block */
  blockTimestamp?: number;
  from: string;
  to: string | null;
  value: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  input: string;
  /** 1 = success, 0 = failure */
  status: number;
  sighash: string | null;
}

export interface HyperSyncTokenTransfer {
  transactionHash: string;
  blockNumber: number;
  /** From joined block */
  blockTimestamp?: number;
  logIndex: number;
  contractAddress: string;
  from: string;
  to: string;
  /** Raw uint256 from log data (ERC-20) or 1n for ERC-721 */
  value: bigint;
  /** true if value field is absent (ERC-721 pattern) */
  isNft: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pads a 20-byte address to 32-byte topic format */
export function padAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, "");
  return `0x${"0".repeat(24)}${hex}`;
}

const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ---------------------------------------------------------------------------
// fetchTransactionsByAddress
// ---------------------------------------------------------------------------

export async function fetchTransactionsByAddress(
  client: HypersyncClient,
  wallet: string,
  fromBlock: number,
  toBlock?: number,
): Promise<HyperSyncTransaction[]> {
  const walletLower = wallet.toLowerCase();

  const transactions: TransactionSelection[] = [
    { include: { from: [walletLower] } },
    { include: { to: [walletLower] } },
  ];

  const fieldSelection: FieldSelection = {
    transaction: [
      "BlockNumber",
      "Hash",
      "From",
      "To",
      "Value",
      "GasUsed",
      "GasPrice",
      "EffectiveGasPrice",
      "Input",
      "Status",
      "Sighash",
    ] as TransactionField[],
    block: ["Number", "Timestamp"] as BlockField[],
  };

  const resultMap = new Map<string, HyperSyncTransaction>();
  let currentBlock = fromBlock;

  while (true) {
    const response = await client.get({
      fromBlock: currentBlock,
      toBlock,
      transactions,
      fieldSelection,
      joinMode: JoinMode.Default,
    });

    // Build block timestamp map for this page
    const blockTimestamps = new Map<number, number>();
    for (const block of response.data.blocks) {
      if (block.number !== undefined && block.timestamp !== undefined) {
        blockTimestamps.set(block.number, block.timestamp);
      }
    }

    // Normalise transactions
    for (const tx of response.data.transactions) {
      if (!tx.hash) continue;
      if (tx.blockNumber === undefined) continue; // skip pending/unconfirmed

      const hash = tx.hash.toLowerCase();
      if (resultMap.has(hash)) continue; // dedup safety

      const blockNumber = tx.blockNumber;
      const gasPrice = tx.effectiveGasPrice ?? tx.gasPrice ?? 0n;

      resultMap.set(hash, {
        hash,
        blockNumber,
        blockTimestamp: blockTimestamps.get(blockNumber),
        from: tx.from?.toLowerCase() ?? "",
        to: tx.to ? tx.to.toLowerCase() : null,
        value: tx.value ?? 0n,
        gasUsed: tx.gasUsed ?? 0n,
        gasPrice,
        input: tx.input ?? "0x",
        status: tx.status ?? 0,
        sighash: tx.sighash ?? null,
      });
    }

    // When toBlock and archiveHeight are both absent (live node), targetEnd = nextBlock
    // → loop terminates after the first page. Callers should pass toBlock when
    // querying live nodes to avoid silent truncation.
    const targetEnd = toBlock ?? response.archiveHeight ?? response.nextBlock;
    if (response.nextBlock >= targetEnd) break;
    currentBlock = response.nextBlock;
  }

  return Array.from(resultMap.values());
}

// ---------------------------------------------------------------------------
// fetchTokenTransfersByAddress
// ---------------------------------------------------------------------------

export async function fetchTokenTransfersByAddress(
  client: HypersyncClient,
  wallet: string,
  fromBlock: number,
  toBlock?: number,
): Promise<HyperSyncTokenTransfer[]> {
  const paddedWallet = padAddress(wallet);

  const logs: LogSelection[] = [
    // wallet is sender (topic1)
    {
      include: {
        topics: [[ERC20_TRANSFER_TOPIC0], [paddedWallet]],
      },
    },
    // wallet is receiver (topic2)
    {
      include: {
        topics: [[ERC20_TRANSFER_TOPIC0], [], [paddedWallet]],
      },
    },
  ];

  const fieldSelection: FieldSelection = {
    log: [
      "LogIndex",
      "TransactionHash",
      "BlockNumber",
      "Address",
      "Data",
      "Topic0",
      "Topic1",
      "Topic2",
      "Topic3",
    ] as LogField[],
    block: ["Number", "Timestamp"] as BlockField[],
  };

  const resultMap = new Map<string, HyperSyncTokenTransfer>();
  let currentBlock = fromBlock;

  while (true) {
    const response = await client.get({
      fromBlock: currentBlock,
      toBlock,
      logs,
      fieldSelection,
      joinMode: JoinMode.Default,
    });

    // Build block timestamp map for this page
    const blockTimestamps = new Map<number, number>();
    for (const block of response.data.blocks) {
      if (block.number !== undefined && block.timestamp !== undefined) {
        blockTimestamps.set(block.number, block.timestamp);
      }
    }

    // Normalise logs
    for (const log of response.data.logs) {
      if (!log.transactionHash || log.logIndex === undefined) continue;
      if (log.blockNumber === undefined) continue; // skip pending/unconfirmed

      const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      if (resultMap.has(key)) continue; // dedup safety

      const blockNumber = log.blockNumber;

      // Parse from/to from topics (padded 32-byte addresses → last 20 bytes)
      const topic1 = log.topics[1];
      const topic2 = log.topics[2];
      const fromAddr = topic1 ? "0x" + topic1.slice(-40) : "";
      const toAddr = topic2 ? "0x" + topic2.slice(-40) : "";

      // Parse value from log.data
      let value: bigint;
      let isNft: boolean;
      const data = log.data;
      if (!data || data === "0x" || data === "") {
        value = 1n;
        isNft = true;
      } else {
        // data is a 0x-prefixed 32-byte hex uint256
        const hex = data.startsWith("0x") ? data.slice(2) : data;
        value = hex.length > 0 ? BigInt("0x" + hex.slice(-64).padStart(64, "0")) : 1n;
        isNft = false;
      }

      resultMap.set(key, {
        transactionHash: log.transactionHash.toLowerCase(),
        blockNumber,
        blockTimestamp: blockTimestamps.get(blockNumber),
        logIndex: log.logIndex,
        contractAddress: log.address?.toLowerCase() ?? "",
        from: fromAddr.toLowerCase(),
        to: toAddr.toLowerCase(),
        value,
        isNft,
      });
    }

    // When toBlock and archiveHeight are both absent (live node), targetEnd = nextBlock
    // → loop terminates after the first page. Callers should pass toBlock when
    // querying live nodes to avoid silent truncation.
    const targetEnd = toBlock ?? response.archiveHeight ?? response.nextBlock;
    if (response.nextBlock >= targetEnd) break;
    currentBlock = response.nextBlock;
  }

  return Array.from(resultMap.values());
}

// ---------------------------------------------------------------------------
// fetchLogsByAddressAndTopics
// ---------------------------------------------------------------------------

/** Pads a uint256 value to a 32-byte (64 hex char) topic format */
export function padUint256(n: bigint): string {
  const hex = n.toString(16);
  return `0x${hex.padStart(64, "0")}`;
}

/** Generic raw log from HyperSync with optional block join */
export interface HyperSyncRawLog {
  transactionHash: string;
  blockNumber: number;
  /** From joined block — may be undefined if block join missed */
  blockTimestamp?: number;
  logIndex: number;
  address: string;
  /** Array of topic hex strings (0x-prefixed), sparse — absent topics are empty string */
  topics: string[];
  data: string;
}

/**
 * Generic paginated log fetcher using HyperSync SDK.
 * Filters by address and topics, with block timestamp join.
 */
export async function fetchLogsByAddressAndTopics(
  client: HypersyncClient,
  address: string,
  topicFilters: string[][],
  fromBlock: number,
  toBlock?: number,
): Promise<HyperSyncRawLog[]> {
  const addressLower = address.toLowerCase();

  const logs: LogSelection[] = [
    {
      include: {
        address: [addressLower],
        topics: topicFilters,
      },
    },
  ];

  const fieldSelection: FieldSelection = {
    log: [
      "LogIndex",
      "TransactionHash",
      "BlockNumber",
      "Address",
      "Data",
      "Topic0",
      "Topic1",
      "Topic2",
      "Topic3",
    ] as LogField[],
    block: ["Number", "Timestamp"] as BlockField[],
  };

  const resultMap = new Map<string, HyperSyncRawLog>();
  let currentBlock = fromBlock;

  while (true) {
    const response = await client.get({
      fromBlock: currentBlock,
      toBlock,
      logs,
      fieldSelection,
      joinMode: JoinMode.Default,
    });

    // Build block timestamp map for this page
    const blockTimestamps = new Map<number, number>();
    for (const block of response.data.blocks) {
      if (block.number !== undefined && block.timestamp !== undefined) {
        blockTimestamps.set(block.number, block.timestamp);
      }
    }

    // Normalise logs
    for (const log of response.data.logs) {
      if (!log.transactionHash || log.logIndex === undefined) continue;
      if (log.blockNumber === undefined) continue;

      const key = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      if (resultMap.has(key)) continue; // dedup safety

      const blockNumber = log.blockNumber;

      // Build 4-element topics array (absent topics default to empty string)
      const topics = [
        log.topics[0] ?? "",
        log.topics[1] ?? "",
        log.topics[2] ?? "",
        log.topics[3] ?? "",
      ].map((t) => t.toLowerCase());

      resultMap.set(key, {
        transactionHash: log.transactionHash.toLowerCase(),
        blockNumber,
        blockTimestamp: blockTimestamps.get(blockNumber),
        logIndex: log.logIndex,
        address: log.address?.toLowerCase() ?? "",
        topics,
        data: log.data ?? "0x",
      });
    }

    // When toBlock and archiveHeight are both absent (live node), targetEnd = nextBlock
    // → loop terminates after the first page. Callers should pass toBlock when
    // querying live nodes to avoid silent truncation.
    const targetEnd = toBlock ?? response.archiveHeight ?? response.nextBlock;
    if (response.nextBlock >= targetEnd) break;
    currentBlock = response.nextBlock;
  }

  return Array.from(resultMap.values());
}
