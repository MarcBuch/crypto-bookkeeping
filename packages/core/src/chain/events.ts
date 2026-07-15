import { parseAbiItem, decodeEventLog, type Address } from "viem";

import { getErrorMessage, isHexString, isRecord } from "../utils/guards.js";
import type { Client } from "./client";
import { fetchLogsByAddressAndTopics, padUint256, type HypersyncClient } from "./hypersync.js";
import { withRetry } from "./rpc";

type HexString = `0x${string}`;
type ReceiptQuery = { hash: HexString };
type ReceiptLike = {
  blockNumber: bigint;
  transactionHash: HexString;
  logs: ReadonlyArray<{
    topics: ReadonlyArray<string>;
    data: string;
  }>;
  [key: string]: unknown;
};

type EventClient = Pick<Client, "getBlockNumber" | "getLogs"> &
  Partial<{
    getTransactionReceipt: (args: ReceiptQuery) => Promise<ReceiptLike>;
  }>;
type ReceiptClient = {
  getTransactionReceipt: (args: ReceiptQuery) => Promise<ReceiptLike>;
};
type LogsClient = Pick<Client, "getLogs">;
type PoolPriceClient = Pick<Client, "readContract">;
type PositionEventName = "IncreaseLiquidity" | "DecreaseLiquidity" | "Collect";

type PositionLogRecord = {
  blockNumber: bigint;
  transactionHash: HexString;
  logIndex?: bigint;
  args?: unknown;
  topics?: ReadonlyArray<string | null | undefined>;
  data?: string;
};

type PositionLogSource = {
  kind: "viem" | "hypersync";
  getLatestBlock: () => Promise<bigint>;
  getReceipt: ((args: ReceiptQuery) => Promise<ReceiptLike>) | null;
  getLogs: (
    eventName: PositionEventName,
    positionManager: Address,
    tokenId: bigint,
    fromBlock: bigint,
    toBlock: bigint,
  ) => Promise<PositionLogRecord[]>;
};

type LiquidityArgs = {
  tokenId: bigint;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
};

type CollectArgs = {
  tokenId: bigint;
  amount0Collect: bigint;
  amount1Collect: bigint;
};

// Discriminated union for event lookup results
export type EventResult<T> =
  | { status: "found"; event: T }
  | { status: "not_found" }
  | { status: "rpc_error"; error: unknown };

// Event topic hashes
const INCREASE_LIQUIDITY_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const DECREASE_LIQUIDITY_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
const COLLECT_TOPIC = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01";

// Envio HyperRPC (https://hyperliquid.rpc.hypersync.xyz) supports up to
// 100_000 blocks per getLogs call. The public Hyperliquid RPC was limited to
// 1_000, but we now use HyperRPC exclusively.
const LOGS_CHUNK_SIZE = 100_000n;

// HyperEVM produces ~1 block/sec. 30 days ≈ 2,592,000 blocks.
// Used as the default getLogs scan window when no explicit fromBlock is provided.
const DEFAULT_LOGS_WINDOW_BLOCKS = 2_592_000n;

const INCREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const DECREASE_LIQUIDITY_EVENT = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const COLLECT_EVENT = parseAbiItem(
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)",
);

const eventAbi = [
  INCREASE_LIQUIDITY_EVENT,
  DECREASE_LIQUIDITY_EVENT,
  COLLECT_EVENT,
  parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
];

const EVENT_TOPICS: Record<PositionEventName, HexString> = {
  IncreaseLiquidity: INCREASE_LIQUIDITY_TOPIC,
  DecreaseLiquidity: DECREASE_LIQUIDITY_TOPIC,
  Collect: COLLECT_TOPIC,
};

const EVENT_FILTERS = {
  IncreaseLiquidity: INCREASE_LIQUIDITY_EVENT,
  DecreaseLiquidity: DECREASE_LIQUIDITY_EVENT,
  Collect: COLLECT_EVENT,
} as const;

export interface PositionOpenEvent {
  tokenId: bigint;
  blockNumber: bigint;
  transactionHash: string;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
}

export interface PositionCloseEvent {
  tokenId: bigint;
  blockNumber: bigint;
  transactionHash: string;
  amount0: bigint;
  amount1: bigint;
  liquidity: bigint;
  cumulativeAmount0: bigint;
  cumulativeAmount1: bigint;
  collectedFees0: bigint;
  collectedFees1: bigint;
}

/**
 * Find the open (IncreaseLiquidity) event for a position.
 *
 * Fast path: use known openTx hash (single getTransactionReceipt call).
 * Slow path: paginated eth_getLogs scan from genesis (or fromBlock if provided).
 * HyperRPC supports large block ranges so this is fast even from block 0.
 */
export async function findOpenEvent(
  client: EventClient,
  positionManager: Address,
  tokenId: bigint,
  wallet: Address,
  knownOpenTx?: string,
  fromBlock?: bigint,
  windowBlocks?: bigint,
  latestBlock?: bigint,
  hyperSyncClient?: HypersyncClient,
): Promise<EventResult<PositionOpenEvent>> {
  try {
    const source = createPositionLogSource(client, hyperSyncClient);
    // Fast path: use known transaction hash
    if (knownOpenTx) {
      const getTransactionReceipt = source.getReceipt;
      if (!getTransactionReceipt) {
        throw new Error("Client does not support getTransactionReceipt");
      }
      console.log(`    Using known open tx: ${knownOpenTx.slice(0, 10)}...`);
      const receipt = await withRetry(() =>
        getTransactionReceipt({ hash: toHexString(knownOpenTx, "knownOpenTx") }),
      );
      const event = extractIncreaseLiquidity(receipt, tokenId);
      if (event) return { status: "found", event };
      console.warn(`    IncreaseLiquidity not found in known tx, falling back to log scan...`);
    }

    // Slow path: paginated getLogs scan
    console.log(`    Scanning logs for open event of token #${tokenId}...`);
    const resolvedLatestBlock = latestBlock ?? (await source.getLatestBlock());

    let startBlock: bigint;
    if (fromBlock !== undefined) {
      // Explicit fromBlock always wins (e.g. close-event scan from entry block)
      startBlock = fromBlock;
    } else {
      const window = windowBlocks ?? DEFAULT_LOGS_WINDOW_BLOCKS;
      // Clamp to >= 1n (block 0 is invalid on HyperEVM)
      startBlock = resolvedLatestBlock > window ? resolvedLatestBlock - window : 1n;
    }

    if (source.kind === "hypersync") {
      const logs = await source.getLogs(
        "IncreaseLiquidity",
        positionManager,
        tokenId,
        startBlock,
        resolvedLatestBlock,
      );
      const event = logs.length > 0 ? toOpenEvent(logs[0], tokenId) : null;
      if (event) {
        console.log(`    Found open event at block ${event.blockNumber}`);
        return { status: "found", event };
      }
      console.warn(`    Could not find open event for token #${tokenId}`);
      return { status: "not_found" };
    } else {
      // viem fallback: existing pagination loop
      for (let lo = startBlock; lo <= resolvedLatestBlock; lo += LOGS_CHUNK_SIZE) {
        const hi =
          lo + LOGS_CHUNK_SIZE - 1n < resolvedLatestBlock
            ? lo + LOGS_CHUNK_SIZE - 1n
            : resolvedLatestBlock;

        const logs = await source.getLogs("IncreaseLiquidity", positionManager, tokenId, lo, hi);

        if (logs.length > 0) {
          const event = toOpenEvent(logs[0], tokenId);
          if (!event) continue;
          console.log(`    Found open event at block ${event.blockNumber}`);
          return { status: "found", event };
        }
      }

      console.warn(`    Could not find open event for token #${tokenId}`);
      return { status: "not_found" };
    }
  } catch (error) {
    console.error(`    Error finding open event for token ${tokenId}:`, getErrorMessage(error));
    return { status: "rpc_error", error };
  }
}

/**
 * Find the close (DecreaseLiquidity + Collect) event for a position.
 *
 * Fast path: use known closeTx hash.
 * Slow path: paginated getLogs scan starting from fromBlock (entry block).
 * Fetches DecreaseLiquidity and Collect logs in the same pass.
 */
export async function findCloseEvent(
  client: EventClient,
  positionManager: Address,
  tokenId: bigint,
  wallet: Address,
  knownCloseTx?: string,
  fromBlock?: bigint,
  windowBlocks?: bigint,
  latestBlock?: bigint,
  hyperSyncClient?: HypersyncClient,
): Promise<EventResult<PositionCloseEvent>> {
  try {
    const source = createPositionLogSource(client, hyperSyncClient);
    // Fast path: use known transaction hash
    if (knownCloseTx) {
      const getTransactionReceipt = source.getReceipt;
      if (!getTransactionReceipt) {
        throw new Error("Client does not support getTransactionReceipt");
      }
      console.log(`    Using known close tx: ${knownCloseTx.slice(0, 10)}...`);
      const receipt = await withRetry(() =>
        getTransactionReceipt({ hash: toHexString(knownCloseTx, "knownCloseTx") }),
      );
      let event = extractDecreaseLiquidity(receipt, tokenId);
      if (event) {
        // Determine the earliest block to scan for Collect events.
        // If entry_block is known use it; otherwise fall back to a rolling window
        // ending at the close block so that partial fee claims made before the
        // close tx are still counted.
        const window = windowBlocks ?? DEFAULT_LOGS_WINDOW_BLOCKS;
        const collectFromBlock =
          fromBlock !== undefined
            ? fromBlock
            : receipt.blockNumber > window
              ? receipt.blockNumber - window
              : 1n;

        const [decreaseTotals, collectTotals] = await Promise.all([
          sumDecreaseLiquidityLogs(
            client,
            positionManager,
            tokenId,
            collectFromBlock,
            receipt.blockNumber,
            hyperSyncClient,
          ),
          sumCollectLogsPublic(
            client,
            positionManager,
            tokenId,
            collectFromBlock,
            receipt.blockNumber,
            hyperSyncClient,
          ),
        ]);
        event = applyCollectTotals(
          withCumulativeWithdrawalTotals(event, decreaseTotals),
          collectTotals,
          decreaseTotals,
        );
      }
      if (event) return { status: "found", event };
      console.warn(`    DecreaseLiquidity not found in known tx, falling back to log scan...`);
    }

    // Slow path: paginated getLogs scan
    console.log(`    Scanning logs for close event of token #${tokenId}...`);
    const resolvedLatestBlock = latestBlock ?? (await source.getLatestBlock());

    let startBlock: bigint;
    if (fromBlock !== undefined) {
      // Explicit fromBlock always wins (e.g. close-event scan from entry block)
      startBlock = fromBlock;
    } else {
      const window = windowBlocks ?? DEFAULT_LOGS_WINDOW_BLOCKS;
      // Clamp to >= 1n (block 0 is invalid on HyperEVM)
      startBlock = resolvedLatestBlock > window ? resolvedLatestBlock - window : 1n;
    }

    if (source.kind === "hypersync") {
      // SDK path: fetch DecreaseLiquidity and Collect logs in parallel
      const [decreaseLogs, collectLogs] = await Promise.all([
        source.getLogs(
          "DecreaseLiquidity",
          positionManager,
          tokenId,
          startBlock,
          resolvedLatestBlock,
        ),
        source.getLogs("Collect", positionManager, tokenId, startBlock, resolvedLatestBlock),
      ]);

      if (decreaseLogs.length === 0) {
        console.warn(`    Could not find close event for token #${tokenId}`);
        return { status: "not_found" };
      }

      const dLog = selectLatestLog(decreaseLogs);
      if (!dLog) {
        console.warn(`    Could not find close event for token #${tokenId}`);
        return { status: "not_found" };
      }
      const event = toCloseEvent(dLog, tokenId);
      if (!event) {
        console.warn(`    Could not decode close event for token #${tokenId}`);
        return { status: "not_found" };
      }

      console.log(`    Found close event at block ${event.blockNumber}`);

      // Sum collect amounts for fees, but only up to and including the close block
      // (in case the tokenId is reused in a new lifecycle after this close)
      // Collect logs were fetched in parallel to toBlock (we didn't know the close
      // block yet); bound them here to exclude any logs from a future position lifecycle.
      let collectAmount0 = 0n;
      let collectAmount1 = 0n;
      const boundedCollectLogs = collectLogs.filter((c) => c.blockNumber <= event.blockNumber);
      for (const cLog of boundedCollectLogs) {
        const cArgs = getCollectArgs(cLog);
        if (!cArgs) continue;
        collectAmount0 += cArgs.amount0Collect;
        collectAmount1 += cArgs.amount1Collect;
      }

      const decreaseTotals = { amount0: event.amount0, amount1: event.amount1 };
      for (const decLog of decreaseLogs) {
        if (decLog === dLog || decLog.blockNumber > event.blockNumber) continue;
        const priorDecreaseArgs = getLiquidityArgs(decLog, "DecreaseLiquidity");
        if (!priorDecreaseArgs) continue;
        decreaseTotals.amount0 += priorDecreaseArgs.amount0;
        decreaseTotals.amount1 += priorDecreaseArgs.amount1;
      }

      const collectTotals = { amount0: collectAmount0, amount1: collectAmount1 };
      return {
        status: "found",
        event: applyCollectTotals(
          withCumulativeWithdrawalTotals(event, decreaseTotals),
          collectTotals,
          decreaseTotals,
        ),
      };
    } else {
      let selectedLog: PositionLogRecord | null = null;

      for (let lo = startBlock; lo <= resolvedLatestBlock; lo += LOGS_CHUNK_SIZE) {
        const hi =
          lo + LOGS_CHUNK_SIZE - 1n < resolvedLatestBlock
            ? lo + LOGS_CHUNK_SIZE - 1n
            : resolvedLatestBlock;

        const decreaseLogs = await source.getLogs(
          "DecreaseLiquidity",
          positionManager,
          tokenId,
          lo,
          hi,
        );

        selectedLog = selectLatestLog([selectedLog, ...decreaseLogs].filter(isDefined));
      }

      if (selectedLog) {
        const event = toCloseEvent(selectedLog, tokenId);
        if (event) {
          console.log(`    Found close event at block ${event.blockNumber}`);
          const [decreaseTotals, collectTotals] = await Promise.all([
            sumDecreaseLiquidityLogsFromSource(
              source,
              positionManager,
              tokenId,
              startBlock,
              event.blockNumber,
            ),
            sumCollectLogsFromSource(
              source,
              positionManager,
              tokenId,
              startBlock,
              event.blockNumber,
            ),
          ]);
          return {
            status: "found",
            event: applyCollectTotals(
              withCumulativeWithdrawalTotals(event, decreaseTotals),
              collectTotals,
              decreaseTotals,
            ),
          };
        }
      }

      console.warn(`    Could not find close event for token #${tokenId}`);
      return { status: "not_found" };
    }
  } catch (error) {
    console.error(`    Error finding close event for token ${tokenId}:`, getErrorMessage(error));
    return { status: "rpc_error", error };
  }
}

/**
 * Find open event using a known transaction hash (most efficient).
 */
export async function findOpenEventFromTx(
  client: ReceiptClient,
  txHash: string,
  tokenId: bigint,
): Promise<PositionOpenEvent | null> {
  const receipt = await withRetry(() =>
    client.getTransactionReceipt({ hash: toHexString(txHash, "txHash") }),
  );
  return extractIncreaseLiquidity(receipt, tokenId);
}

/**
 * Find close event using a known transaction hash.
 */
export async function findCloseEventFromTx(
  client: ReceiptClient,
  txHash: string,
  tokenId: bigint,
): Promise<PositionCloseEvent | null> {
  const receipt = await withRetry(() =>
    client.getTransactionReceipt({ hash: toHexString(txHash, "txHash") }),
  );
  return extractDecreaseLiquidity(receipt, tokenId);
}

/**
 * Sum all DecreaseLiquidity events for a position between two blocks.
 * Used to account for partial withdrawals on active positions so that
 * capital removed mid-life is included in the exit-side P&L calculation.
 */
export async function sumDecreaseLiquidityLogs(
  client: LogsClient,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
  hyperSyncClient?: HypersyncClient,
): Promise<{ amount0: bigint; amount1: bigint }> {
  return sumDecreaseLiquidityLogsFromSource(
    createPositionLogSource(client, hyperSyncClient),
    positionManager,
    tokenId,
    fromBlock,
    toBlock,
  );
}

/**
 * Sum all Collect events for a position between two blocks.
 * Exported so callers can account for fees already claimed on active positions.
 */
export async function sumCollectLogsPublic(
  client: LogsClient,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
  hyperSyncClient?: HypersyncClient,
): Promise<{ amount0: bigint; amount1: bigint }> {
  return sumCollectLogsFromSource(
    createPositionLogSource(client, hyperSyncClient),
    positionManager,
    tokenId,
    fromBlock,
    toBlock,
  );
}

function applyCollectTotals(
  event: PositionCloseEvent,
  collectTotals: { amount0: bigint; amount1: bigint },
  principalTotals: { amount0: bigint; amount1: bigint } = {
    amount0: event.amount0,
    amount1: event.amount1,
  },
): PositionCloseEvent {
  return {
    ...event,
    collectedFees0:
      collectTotals.amount0 > principalTotals.amount0
        ? collectTotals.amount0 - principalTotals.amount0
        : 0n,
    collectedFees1:
      collectTotals.amount1 > principalTotals.amount1
        ? collectTotals.amount1 - principalTotals.amount1
        : 0n,
  };
}

// === Internal helpers ===

function createPositionLogSource(
  client: EventClient | LogsClient,
  hyperSyncClient?: HypersyncClient,
): PositionLogSource {
  return hyperSyncClient
    ? createHyperSyncPositionLogSource(client, hyperSyncClient)
    : createViemPositionLogSource(client);
}

function createViemPositionLogSource(client: EventClient | LogsClient): PositionLogSource {
  return {
    kind: "viem",
    getLatestBlock: async () => {
      if (!("getBlockNumber" in client) || typeof client.getBlockNumber !== "function") {
        throw new Error("Client does not support getBlockNumber");
      }
      return withRetry(() => client.getBlockNumber());
    },
    getReceipt:
      "getTransactionReceipt" in client && typeof client.getTransactionReceipt === "function"
        ? (args) => withRetry(() => client.getTransactionReceipt!(args))
        : null,
    getLogs: async (eventName, positionManager, tokenId, fromBlock, toBlock) => {
      const logs = await withRetry(() =>
        client.getLogs({
          address: positionManager,
          event: EVENT_FILTERS[eventName],
          args: { tokenId },
          fromBlock,
          toBlock,
        }),
      );

      return logs.flatMap((log) => {
        if (log.blockNumber == null || log.transactionHash == null) {
          return [];
        }
        const transactionHash = toLogTransactionHash(log.transactionHash);
        if (!transactionHash) {
          return [];
        }
        return [
          {
            blockNumber: log.blockNumber,
            transactionHash,
            logIndex: toBigInt(log.logIndex) ?? undefined,
            args: log.args,
          },
        ];
      });
    },
  };
}

function createHyperSyncPositionLogSource(
  client: EventClient | LogsClient,
  hyperSyncClient: HypersyncClient,
): PositionLogSource {
  const viemSource = createViemPositionLogSource(client);
  return {
    kind: "hypersync",
    getLatestBlock: viemSource.getLatestBlock,
    getReceipt: viemSource.getReceipt,
    getLogs: async (eventName, positionManager, tokenId, fromBlock, toBlock) => {
      const rawLogs = await fetchLogsByAddressAndTopics(
        hyperSyncClient,
        positionManager,
        [[EVENT_TOPICS[eventName]], [padUint256(tokenId)]],
        Number(fromBlock),
        Number(toBlock) + 1,
      );

      return rawLogs.flatMap((log) => {
        const transactionHash = toLogTransactionHash(log.transactionHash);
        if (!transactionHash) {
          return [];
        }
        return [
          {
            blockNumber: BigInt(log.blockNumber),
            transactionHash,
            logIndex: BigInt(log.logIndex),
            topics: log.topics,
            data: log.data,
          },
        ];
      });
    },
  };
}

async function sumDecreaseLiquidityLogsFromSource(
  source: PositionLogSource,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ amount0: bigint; amount1: bigint }> {
  return sumPositionLogsFromSource(
    source,
    "DecreaseLiquidity",
    positionManager,
    tokenId,
    fromBlock,
    toBlock,
    (log) => {
      const args = getLiquidityArgs(log, "DecreaseLiquidity");
      return args ? { amount0: args.amount0, amount1: args.amount1 } : null;
    },
  );
}

async function sumCollectLogsFromSource(
  source: PositionLogSource,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ amount0: bigint; amount1: bigint }> {
  return sumPositionLogsFromSource(
    source,
    "Collect",
    positionManager,
    tokenId,
    fromBlock,
    toBlock,
    (log) => {
      const args = getCollectArgs(log);
      return args ? { amount0: args.amount0Collect, amount1: args.amount1Collect } : null;
    },
  );
}

async function sumPositionLogsFromSource(
  source: PositionLogSource,
  eventName: PositionEventName,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
  getAmounts: (log: PositionLogRecord) => { amount0: bigint; amount1: bigint } | null,
): Promise<{ amount0: bigint; amount1: bigint }> {
  let amount0 = 0n;
  let amount1 = 0n;

  if (source.kind === "hypersync") {
    const logs = await source.getLogs(eventName, positionManager, tokenId, fromBlock, toBlock);
    for (const log of logs) {
      const amounts = getAmounts(log);
      if (!amounts) continue;
      amount0 += amounts.amount0;
      amount1 += amounts.amount1;
    }
    return { amount0, amount1 };
  }

  for (let lo = fromBlock; lo <= toBlock; lo += LOGS_CHUNK_SIZE) {
    const hi = lo + LOGS_CHUNK_SIZE - 1n < toBlock ? lo + LOGS_CHUNK_SIZE - 1n : toBlock;
    const logs = await source.getLogs(eventName, positionManager, tokenId, lo, hi);
    for (const log of logs) {
      const amounts = getAmounts(log);
      if (!amounts) continue;
      amount0 += amounts.amount0;
      amount1 += amounts.amount1;
    }
  }

  return { amount0, amount1 };
}

function toOpenEvent(log: PositionLogRecord, tokenId: bigint): PositionOpenEvent | null {
  const args = getLiquidityArgs(log, "IncreaseLiquidity");
  if (!args || args.tokenId !== tokenId) {
    return null;
  }
  return {
    tokenId,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    amount0: args.amount0,
    amount1: args.amount1,
    liquidity: args.liquidity,
  };
}

function selectLatestLog(logs: readonly PositionLogRecord[]): PositionLogRecord | null {
  let latest: PositionLogRecord | null = null;
  for (const log of logs) {
    if (!latest) {
      latest = log;
      continue;
    }
    if (log.blockNumber > latest.blockNumber) {
      latest = log;
      continue;
    }
    if (log.blockNumber === latest.blockNumber && compareLogOrder(log, latest) > 0) {
      latest = log;
    }
  }
  return latest;
}

function compareLogOrder(a: PositionLogRecord, b: PositionLogRecord): number {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber > b.blockNumber ? 1 : -1;
  }

  if (a.logIndex !== undefined && b.logIndex !== undefined) {
    if (a.logIndex === b.logIndex) return 0;
    return a.logIndex > b.logIndex ? 1 : -1;
  }

  if (a.logIndex !== undefined) return 1;
  if (b.logIndex !== undefined) return -1;
  return 0;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function toCloseEvent(log: PositionLogRecord, tokenId: bigint): PositionCloseEvent | null {
  const args = getLiquidityArgs(log, "DecreaseLiquidity");
  if (!args || args.tokenId !== tokenId) {
    return null;
  }
  return {
    tokenId,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    amount0: args.amount0,
    amount1: args.amount1,
    liquidity: args.liquidity,
    cumulativeAmount0: args.amount0,
    cumulativeAmount1: args.amount1,
    collectedFees0: 0n,
    collectedFees1: 0n,
  };
}

function getLiquidityArgs(
  log: PositionLogRecord,
  eventName: "IncreaseLiquidity" | "DecreaseLiquidity",
): LiquidityArgs | null {
  if (log.args !== undefined) {
    return toLiquidityArgs(log.args);
  }
  const decoded = decodePositionLog(log);
  return decoded && decoded.eventName === eventName ? toLiquidityArgs(decoded.args) : null;
}

function getCollectArgs(log: PositionLogRecord): CollectArgs | null {
  if (log.args !== undefined) {
    return toCollectArgs(log.args);
  }
  const decoded = decodePositionLog(log);
  return decoded && decoded.eventName === "Collect" ? toCollectArgs(decoded.args) : null;
}

function decodePositionLog(log: PositionLogRecord): any {
  if (!log.topics) {
    return null;
  }
  return decodeTopicsAndData(log.topics, log.data ?? "0x", log.transactionHash, "");
}

function toLogTransactionHash(value: string): HexString | null {
  return isHexString(value) ? value : null;
}

function decodeTopicsAndData(
  topicsInput: ReadonlyArray<string | null | undefined>,
  dataInput: string,
  transactionHash: string,
  logIndex: string,
): any {
  try {
    const validTopics = toTopics(topicsInput);
    if (!validTopics) {
      return null;
    }

    // Normalise data: SDK may return "" instead of "0x" for empty-data logs.
    const data = isHexString(dataInput) ? dataInput : "0x";

    return decodeEventLog({
      abi: eventAbi,
      data,
      topics: validTopics,
      strict: false,
    });
  } catch (err) {
    console.warn(
      `    decodeHyperSyncLog: failed for tx ${transactionHash} logIndex ${logIndex}:`,
      getErrorMessage(err),
    );
    return null;
  }
}

function extractIncreaseLiquidity(receipt: ReceiptLike, tokenId: bigint): PositionOpenEvent | null {
  for (const log of receipt.logs) {
    const topics = toTopics(log.topics);
    if (!topics || topics[0] !== INCREASE_LIQUIDITY_TOPIC) continue;

    try {
      const decoded = decodeEventLog({
        abi: eventAbi,
        data: isHexString(log.data) ? log.data : "0x",
        topics,
        strict: false,
      });

      const args = decoded.eventName === "IncreaseLiquidity" ? toLiquidityArgs(decoded.args) : null;
      if (args && args.tokenId === tokenId) {
        return {
          tokenId,
          blockNumber: receipt.blockNumber,
          transactionHash: receipt.transactionHash,
          amount0: args.amount0,
          amount1: args.amount1,
          liquidity: args.liquidity,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractDecreaseLiquidity(
  receipt: ReceiptLike,
  tokenId: bigint,
): PositionCloseEvent | null {
  let decreaseEvent: { amount0: bigint; amount1: bigint; liquidity: bigint } | null = null;
  let collectEvent: { amount0: bigint; amount1: bigint } | null = null;

  for (const log of receipt.logs) {
    try {
      const topics = toTopics(log.topics);
      if (!topics) continue;

      if (topics[0] === DECREASE_LIQUIDITY_TOPIC) {
        const decoded = decodeEventLog({
          abi: eventAbi,
          data: isHexString(log.data) ? log.data : "0x",
          topics,
          strict: false,
        });
        const args =
          decoded.eventName === "DecreaseLiquidity" ? toLiquidityArgs(decoded.args) : null;
        if (args && args.tokenId === tokenId) {
          decreaseEvent = {
            amount0: args.amount0,
            amount1: args.amount1,
            liquidity: args.liquidity,
          };
        }
      } else if (topics[0] === COLLECT_TOPIC) {
        const decoded = decodeEventLog({
          abi: eventAbi,
          data: isHexString(log.data) ? log.data : "0x",
          topics,
          strict: false,
        });
        const args = decoded.eventName === "Collect" ? toCollectArgs(decoded.args) : null;
        if (args && args.tokenId === tokenId) {
          collectEvent = {
            amount0: args.amount0Collect,
            amount1: args.amount1Collect,
          };
        }
      }
    } catch {
      continue;
    }
  }

  if (!decreaseEvent) return null;

  // Fees = Collect amounts - DecreaseLiquidity amounts (Collect includes both principal + fees)
  let collectedFees0 = 0n;
  let collectedFees1 = 0n;
  if (collectEvent) {
    collectedFees0 = collectEvent.amount0 - decreaseEvent.amount0;
    collectedFees1 = collectEvent.amount1 - decreaseEvent.amount1;
    // Guard against negative (shouldn't happen but be safe)
    if (collectedFees0 < 0n) collectedFees0 = 0n;
    if (collectedFees1 < 0n) collectedFees1 = 0n;
  }

  return {
    tokenId,
    blockNumber: receipt.blockNumber,
    transactionHash: receipt.transactionHash,
    amount0: decreaseEvent.amount0,
    amount1: decreaseEvent.amount1,
    liquidity: decreaseEvent.liquidity,
    cumulativeAmount0: decreaseEvent.amount0,
    cumulativeAmount1: decreaseEvent.amount1,
    collectedFees0,
    collectedFees1,
  };
}

function withCumulativeWithdrawalTotals(
  event: PositionCloseEvent,
  cumulativeTotals: { amount0: bigint; amount1: bigint } = {
    amount0: event.amount0,
    amount1: event.amount1,
  },
): PositionCloseEvent {
  return {
    ...event,
    cumulativeAmount0: cumulativeTotals.amount0,
    cumulativeAmount1: cumulativeTotals.amount1,
  };
}

/**
 * Get the pool's sqrtPriceX96 at a specific block number.
 */
export async function getPoolPriceAtBlock(
  client: PoolPriceClient,
  poolAddress: Address,
  blockNumber: bigint,
): Promise<{ sqrtPriceX96: bigint; tick: number } | null> {
  try {
    const result = await withRetry(() =>
      client.readContract({
        address: poolAddress,
        abi: [
          {
            inputs: [],
            name: "slot0",
            outputs: [
              { name: "sqrtPriceX96", type: "uint160" },
              { name: "tick", type: "int24" },
              { name: "observationIndex", type: "uint16" },
              { name: "observationCardinality", type: "uint16" },
              { name: "observationCardinalityNext", type: "uint16" },
              { name: "feeProtocol", type: "uint8" },
              { name: "unlocked", type: "bool" },
            ],
            stateMutability: "view",
            type: "function",
          },
        ] as const,
        functionName: "slot0",
        blockNumber,
      }),
    );

    return {
      sqrtPriceX96: result[0],
      tick: result[1],
    };
  } catch {
    console.warn(`    Could not fetch historical price at block ${blockNumber}.`);
    return null;
  }
}

function toHexString(value: string, label: string): `0x${string}` {
  if (!isHexString(value)) {
    throw new Error(`${label} must be a 0x-prefixed hex string`);
  }
  return value;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function toLiquidityArgs(value: unknown): LiquidityArgs | null {
  if (!isRecord(value)) return null;

  const tokenId = toBigInt(value.tokenId);
  const amount0 = toBigInt(value.amount0);
  const amount1 = toBigInt(value.amount1);
  const liquidity = toBigInt(value.liquidity);

  if (tokenId === null || amount0 === null || amount1 === null || liquidity === null) {
    return null;
  }

  return { tokenId, amount0, amount1, liquidity };
}

function toCollectArgs(value: unknown): CollectArgs | null {
  if (!isRecord(value)) return null;

  const tokenId = toBigInt(value.tokenId);
  const amount0Collect = toBigInt(value.amount0Collect);
  const amount1Collect = toBigInt(value.amount1Collect);

  if (tokenId === null || amount0Collect === null || amount1Collect === null) {
    return null;
  }

  return { tokenId, amount0Collect, amount1Collect };
}

function toTopics(
  topics: ReadonlyArray<string | null | undefined>,
): [`0x${string}`, ...`0x${string}`[]] | null {
  const validTopics = topics
    .filter((topic): topic is string => typeof topic === "string")
    .map((topic) => topic.toLowerCase())
    .filter(isHexString);
  const [first, ...rest] = validTopics;
  return first ? [first, ...rest] : null;
}
