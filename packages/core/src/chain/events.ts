import { parseAbiItem, decodeEventLog, type Address, type TransactionReceipt } from "viem";
import type { HypersyncClient } from "@envio-dev/hypersync-client";

import type { Client } from "./client";
import { withRetry } from "./rpc";
import {
  fetchLogsByAddressAndTopics,
  padUint256,
  type HyperSyncRawLog,
} from "./hypersync.js";

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

const eventAbi = [
  parseAbiItem(
    "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  ),
  parseAbiItem(
    "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  ),
  parseAbiItem(
    "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)",
  ),
  parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
];

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
  client: Client,
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
    // Fast path: use known transaction hash
    if (knownOpenTx) {
      console.log(`    Using known open tx: ${knownOpenTx.slice(0, 10)}...`);
      const receipt = await withRetry(() =>
        client.getTransactionReceipt({ hash: knownOpenTx as `0x${string}` }),
      );
      const event = extractIncreaseLiquidity(receipt, tokenId);
      if (event) return { status: "found", event };
      console.warn(`    IncreaseLiquidity not found in known tx, falling back to log scan...`);
    }

    // Slow path: paginated getLogs scan
    console.log(`    Scanning logs for open event of token #${tokenId}...`);
    const resolvedLatestBlock = latestBlock ?? (await withRetry(() => client.getBlockNumber()));

    let startBlock: bigint;
    if (fromBlock !== undefined) {
      // Explicit fromBlock always wins (e.g. close-event scan from entry block)
      startBlock = fromBlock;
    } else {
      const window = windowBlocks ?? DEFAULT_LOGS_WINDOW_BLOCKS;
      // Clamp to >= 1n (block 0 is invalid on HyperEVM)
      startBlock = resolvedLatestBlock > window ? resolvedLatestBlock - window : 1n;
    }

    if (hyperSyncClient) {
      // SDK path: single call handles pagination internally
      const paddedTokenId = padUint256(tokenId);
      const rawLogs = await fetchLogsByAddressAndTopics(
        hyperSyncClient,
        positionManager,
        [[INCREASE_LIQUIDITY_TOPIC], [paddedTokenId]],
        Number(startBlock),
        resolvedLatestBlock !== undefined ? Number(resolvedLatestBlock) : undefined,
      );

      if (rawLogs.length > 0) {
        const log = rawLogs[0]; // first match is the open event
        console.log(`    Found open event at block ${log.blockNumber}`);
        const decoded = decodeHyperSyncLog(log, eventAbi);
        if (decoded && decoded.eventName === "IncreaseLiquidity") {
          const args = decoded.args as any;
          // Defensive check: SDK filters by topic1, but verify tokenId matches
          if (BigInt(args.tokenId) === tokenId) {
            return {
              status: "found",
              event: {
                tokenId,
                blockNumber: BigInt(log.blockNumber),
                transactionHash: log.transactionHash,
                amount0: BigInt(args.amount0),
                amount1: BigInt(args.amount1),
                liquidity: BigInt(args.liquidity),
              },
            };
          }
        }
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

        const logs = await withRetry(() =>
          client.getLogs({
            address: positionManager,
            event: parseAbiItem(
              "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
            ),
            args: { tokenId },
            fromBlock: lo,
            toBlock: hi,
          }),
        );

        if (logs.length > 0) {
          const log = logs[0];
          console.log(`    Found open event at block ${log.blockNumber}`);
          return {
            status: "found",
            event: {
              tokenId,
              blockNumber: log.blockNumber!,
              transactionHash: log.transactionHash!,
              amount0: BigInt((log.args as any).amount0),
              amount1: BigInt((log.args as any).amount1),
              liquidity: BigInt((log.args as any).liquidity),
            },
          };
        }
      }

      console.warn(`    Could not find open event for token #${tokenId}`);
      return { status: "not_found" };
    }
  } catch (error) {
    console.error(`    Error finding open event for token ${tokenId}:`, (error as Error).message);
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
  client: Client,
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
    // Fast path: use known transaction hash
    if (knownCloseTx) {
      console.log(`    Using known close tx: ${knownCloseTx.slice(0, 10)}...`);
      const receipt = await withRetry(() =>
        client.getTransactionReceipt({ hash: knownCloseTx as `0x${string}` }),
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

        let collectTotals: { amount0: bigint; amount1: bigint };
        if (hyperSyncClient) {
          // SDK path: fetch all Collect logs for this tokenId in the range.
          // HyperSync toBlock is exclusive, so add 1 to include the close block.
          const paddedTokenId = padUint256(tokenId);
          const collectLogs = await fetchLogsByAddressAndTopics(
            hyperSyncClient,
            positionManager,
            [[COLLECT_TOPIC], [paddedTokenId]],
            Number(collectFromBlock),
            Number(receipt.blockNumber) + 1,
          );
          let amount0 = 0n;
          let amount1 = 0n;
          for (const cLog of collectLogs) {
            const collectDecoded = decodeHyperSyncLog(cLog, eventAbi);
            if (collectDecoded && collectDecoded.eventName === "Collect") {
              const cArgs = collectDecoded.args as any;
              amount0 += BigInt(cArgs.amount0Collect);
              amount1 += BigInt(cArgs.amount1Collect);
            }
          }
          collectTotals = { amount0, amount1 };
        } else if (canScanLogs(client)) {
          collectTotals = await sumCollectLogs(
            client,
            positionManager,
            tokenId,
            collectFromBlock,
            receipt.blockNumber,
          );
        } else {
          // No log-scanning capability available — use the Collect already
          // extracted from the close tx receipt (may miss prior fee claims).
          return { status: "found", event };
        }
        event = applyCollectTotals(event, collectTotals);
      }
      if (event) return { status: "found", event };
      console.warn(`    DecreaseLiquidity not found in known tx, falling back to log scan...`);
    }

    // Slow path: paginated getLogs scan
    console.log(`    Scanning logs for close event of token #${tokenId}...`);
    const resolvedLatestBlock = latestBlock ?? (await withRetry(() => client.getBlockNumber()));

    let startBlock: bigint;
    if (fromBlock !== undefined) {
      // Explicit fromBlock always wins (e.g. close-event scan from entry block)
      startBlock = fromBlock;
    } else {
      const window = windowBlocks ?? DEFAULT_LOGS_WINDOW_BLOCKS;
      // Clamp to >= 1n (block 0 is invalid on HyperEVM)
      startBlock = resolvedLatestBlock > window ? resolvedLatestBlock - window : 1n;
    }

    if (hyperSyncClient) {
      // SDK path: fetch DecreaseLiquidity and Collect logs in parallel
      const paddedTokenId = padUint256(tokenId);
      const toBlockNum = resolvedLatestBlock !== undefined ? Number(resolvedLatestBlock) : undefined;

      const [decreaseLogs, collectLogs] = await Promise.all([
        fetchLogsByAddressAndTopics(
          hyperSyncClient,
          positionManager,
          [[DECREASE_LIQUIDITY_TOPIC], [paddedTokenId]],
          Number(startBlock),
          toBlockNum !== undefined ? toBlockNum + 1 : undefined,
        ),
        fetchLogsByAddressAndTopics(
          hyperSyncClient,
          positionManager,
          [[COLLECT_TOPIC], [paddedTokenId]],
          Number(startBlock),
          toBlockNum !== undefined ? toBlockNum + 1 : undefined,
        ),
      ]);

      if (decreaseLogs.length === 0) {
        console.warn(`    Could not find close event for token #${tokenId}`);
        return { status: "not_found" };
      }

      const dLog = decreaseLogs[0];
      const decreaseDecoded = decodeHyperSyncLog(dLog, eventAbi);
      if (!decreaseDecoded || decreaseDecoded.eventName !== "DecreaseLiquidity") {
        console.warn(`    Could not decode close event for token #${tokenId}`);
        return { status: "not_found" };
      }

      const dArgs = decreaseDecoded.args as any;
      const decreaseAmount0 = BigInt(dArgs.amount0);
      const decreaseAmount1 = BigInt(dArgs.amount1);

      console.log(`    Found close event at block ${dLog.blockNumber}`);

      // Sum collect amounts for fees, but only up to and including the close block
      // (in case the tokenId is reused in a new lifecycle after this close)
      // Collect logs were fetched in parallel to toBlock (we didn't know the close
      // block yet); bound them here to exclude any logs from a future position lifecycle.
      let collectAmount0 = 0n;
      let collectAmount1 = 0n;
      const boundedCollectLogs = collectLogs.filter((c) => c.blockNumber <= dLog.blockNumber);
      for (const cLog of boundedCollectLogs) {
        const collectDecoded = decodeHyperSyncLog(cLog, eventAbi);
        if (collectDecoded && collectDecoded.eventName === "Collect") {
          const cArgs = collectDecoded.args as any;
          collectAmount0 += BigInt(cArgs.amount0Collect);
          collectAmount1 += BigInt(cArgs.amount1Collect);
        }
      }

      const collectTotals = { amount0: collectAmount0, amount1: collectAmount1 };
      return {
        status: "found",
        event: applyCollectTotals(
          {
            tokenId,
            blockNumber: BigInt(dLog.blockNumber),
            transactionHash: dLog.transactionHash,
            amount0: decreaseAmount0,
            amount1: decreaseAmount1,
            liquidity: BigInt(dArgs.liquidity),
            collectedFees0: 0n,
            collectedFees1: 0n,
          },
          collectTotals,
        ),
      };
    } else {
      // viem fallback: existing pagination loop
      for (let lo = startBlock; lo <= resolvedLatestBlock; lo += LOGS_CHUNK_SIZE) {
        const hi =
          lo + LOGS_CHUNK_SIZE - 1n < resolvedLatestBlock
            ? lo + LOGS_CHUNK_SIZE - 1n
            : resolvedLatestBlock;

        const decreaseLogs = await withRetry(() =>
          client.getLogs({
            address: positionManager,
            event: parseAbiItem(
              "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
            ),
            args: { tokenId },
            fromBlock: lo,
            toBlock: hi,
          }),
        );

        if (decreaseLogs.length > 0) {
          const dLog = decreaseLogs[0];
          const dArgs = dLog.args as any;
          const decreaseAmount0 = BigInt(dArgs.amount0);
          const decreaseAmount1 = BigInt(dArgs.amount1);

          console.log(`    Found close event at block ${dLog.blockNumber}`);
          const collectTotals = await sumCollectLogs(
            client,
            positionManager,
            tokenId,
            startBlock,
            dLog.blockNumber!,
          );
          return {
            status: "found",
            event: applyCollectTotals(
              {
                tokenId,
                blockNumber: dLog.blockNumber!,
                transactionHash: dLog.transactionHash!,
                amount0: decreaseAmount0,
                amount1: decreaseAmount1,
                liquidity: BigInt(dArgs.liquidity),
                collectedFees0: 0n,
                collectedFees1: 0n,
              },
              collectTotals,
            ),
          };
        }
      }

      console.warn(`    Could not find close event for token #${tokenId}`);
      return { status: "not_found" };
    }
  } catch (error) {
    console.error(`    Error finding close event for token ${tokenId}:`, (error as Error).message);
    return { status: "rpc_error", error };
  }
}

/**
 * Find open event using a known transaction hash (most efficient).
 */
export async function findOpenEventFromTx(
  client: Client,
  txHash: string,
  tokenId: bigint,
): Promise<PositionOpenEvent | null> {
  const receipt = await withRetry(() =>
    client.getTransactionReceipt({ hash: txHash as `0x${string}` }),
  );
  return extractIncreaseLiquidity(receipt, tokenId);
}

/**
 * Find close event using a known transaction hash.
 */
export async function findCloseEventFromTx(
  client: Client,
  txHash: string,
  tokenId: bigint,
): Promise<PositionCloseEvent | null> {
  const receipt = await withRetry(() =>
    client.getTransactionReceipt({ hash: txHash as `0x${string}` }),
  );
  return extractDecreaseLiquidity(receipt, tokenId);
}

function canScanLogs(client: Client): boolean {
  return typeof (client as any).getLogs === "function";
}

async function sumCollectLogs(
  client: Client,
  positionManager: Address,
  tokenId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ amount0: bigint; amount1: bigint }> {
  let amount0 = 0n;
  let amount1 = 0n;

  for (let lo = fromBlock; lo <= toBlock; lo += LOGS_CHUNK_SIZE) {
    const hi = lo + LOGS_CHUNK_SIZE - 1n < toBlock ? lo + LOGS_CHUNK_SIZE - 1n : toBlock;
    const collectLogs = await withRetry(() =>
      client.getLogs({
        address: positionManager,
        event: parseAbiItem(
          "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)",
        ),
        args: { tokenId },
        fromBlock: lo,
        toBlock: hi,
      }),
    );

    for (const log of collectLogs) {
      const args = log.args as any;
      amount0 += BigInt(args.amount0Collect);
      amount1 += BigInt(args.amount1Collect);
    }
  }

  return { amount0, amount1 };
}

function applyCollectTotals(
  event: PositionCloseEvent,
  collectTotals: { amount0: bigint; amount1: bigint },
): PositionCloseEvent {
  return {
    ...event,
    collectedFees0:
      collectTotals.amount0 > event.amount0 ? collectTotals.amount0 - event.amount0 : 0n,
    collectedFees1:
      collectTotals.amount1 > event.amount1 ? collectTotals.amount1 - event.amount1 : 0n,
  };
}

// === Internal helpers ===

/**
 * Decode a HyperSync raw log using viem's decodeEventLog.
 * Filters out empty topic strings before decoding.
 * Uses strict: false to tolerate minor topic-count mismatches that can occur
 * with raw SDK logs (e.g. trailing null topics from the HyperSync wire format).
 */
function decodeHyperSyncLog(log: HyperSyncRawLog, abi: any): any {
  try {
    const validTopics = log.topics
      .filter((t): t is `0x${string}` => t !== "" && t.startsWith("0x"))
      .map((t) => t.toLowerCase() as `0x${string}`);

    // Normalise data: SDK may return "" instead of "0x" for empty-data logs.
    const data = (log.data || "0x") as `0x${string}`;

    return decodeEventLog({
      abi,
      data,
      topics: validTopics as [`0x${string}`, ...`0x${string}`[]],
      strict: false,
    });
  } catch (err) {
    console.warn(
      `    decodeHyperSyncLog: failed for tx ${log.transactionHash} logIndex ${log.logIndex}:`,
      (err as Error).message,
    );
    return null;
  }
}

function extractIncreaseLiquidity(
  receipt: TransactionReceipt,
  tokenId: bigint,
): PositionOpenEvent | null {
  for (const log of receipt.logs) {
    if (log.topics[0] !== INCREASE_LIQUIDITY_TOPIC) continue;

    try {
      const decoded = decodeEventLog({
        abi: eventAbi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "IncreaseLiquidity" && (decoded.args as any).tokenId === tokenId) {
        const args = decoded.args as any;
        return {
          tokenId,
          blockNumber: receipt.blockNumber,
          transactionHash: receipt.transactionHash,
          amount0: BigInt(args.amount0),
          amount1: BigInt(args.amount1),
          liquidity: BigInt(args.liquidity),
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractDecreaseLiquidity(
  receipt: TransactionReceipt,
  tokenId: bigint,
): PositionCloseEvent | null {
  let decreaseEvent: { amount0: bigint; amount1: bigint; liquidity: bigint } | null = null;
  let collectEvent: { amount0: bigint; amount1: bigint } | null = null;

  for (const log of receipt.logs) {
    try {
      if (log.topics[0] === DECREASE_LIQUIDITY_TOPIC) {
        const decoded = decodeEventLog({
          abi: eventAbi,
          data: log.data,
          topics: log.topics,
        });
        if (
          decoded.eventName === "DecreaseLiquidity" &&
          (decoded.args as any).tokenId === tokenId
        ) {
          const args = decoded.args as any;
          decreaseEvent = {
            amount0: BigInt(args.amount0),
            amount1: BigInt(args.amount1),
            liquidity: BigInt(args.liquidity),
          };
        }
      } else if (log.topics[0] === COLLECT_TOPIC) {
        const decoded = decodeEventLog({
          abi: eventAbi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "Collect" && (decoded.args as any).tokenId === tokenId) {
          const args = decoded.args as any;
          collectEvent = {
            amount0: BigInt(args.amount0Collect),
            amount1: BigInt(args.amount1Collect),
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
    collectedFees0,
    collectedFees1,
  };
}

/**
 * Get the pool's sqrtPriceX96 at a specific block number.
 */
export async function getPoolPriceAtBlock(
  client: Client,
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
      sqrtPriceX96: BigInt(result[0]),
      tick: Number(result[1]),
    };
  } catch {
    console.warn(`    Could not fetch historical price at block ${blockNumber}.`);
    return null;
  }
}
