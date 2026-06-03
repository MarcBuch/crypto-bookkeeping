import { parseAbiItem, decodeEventLog, type Address, type TransactionReceipt } from "viem";

import type { Client } from "./client";
import { withRetry } from "./rpc";

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

// The public Hyperliquid RPC enforces a 1000-block getLogs limit.
// When using Envio HyperRPC (https://hyperliquid.rpc.hypersync.xyz) this can
// be raised to 100_000. Set via config or override here.
const LOGS_CHUNK_SIZE = 999n;

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
): Promise<EventResult<PositionCloseEvent>> {
  try {
    // Fast path: use known transaction hash
    if (knownCloseTx) {
      console.log(`    Using known close tx: ${knownCloseTx.slice(0, 10)}...`);
      const receipt = await withRetry(() =>
        client.getTransactionReceipt({ hash: knownCloseTx as `0x${string}` }),
      );
      const event = extractDecreaseLiquidity(receipt, tokenId);
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

    for (let lo = startBlock; lo <= resolvedLatestBlock; lo += LOGS_CHUNK_SIZE) {
      const hi =
        lo + LOGS_CHUNK_SIZE - 1n < resolvedLatestBlock
          ? lo + LOGS_CHUNK_SIZE - 1n
          : resolvedLatestBlock;

      // Fetch DecreaseLiquidity and Collect logs for this tokenId in one pass each
      const [decreaseLogs, collectLogs] = await Promise.all([
        withRetry(() =>
          client.getLogs({
            address: positionManager,
            event: parseAbiItem(
              "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
            ),
            args: { tokenId },
            fromBlock: lo,
            toBlock: hi,
          }),
        ),
        withRetry(() =>
          client.getLogs({
            address: positionManager,
            event: parseAbiItem(
              "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0Collect, uint256 amount1Collect)",
            ),
            args: { tokenId },
            fromBlock: lo,
            toBlock: hi,
          }),
        ),
      ]);

      if (decreaseLogs.length > 0) {
        const dLog = decreaseLogs[0];
        const dArgs = dLog.args as any;
        const decreaseAmount0 = BigInt(dArgs.amount0);
        const decreaseAmount1 = BigInt(dArgs.amount1);

        // Find the Collect log in the same transaction
        const cLog = collectLogs.find((l) => l.transactionHash === dLog.transactionHash);

        let collectedFees0 = 0n;
        let collectedFees1 = 0n;
        if (cLog) {
          const cArgs = cLog.args as any;
          const collectAmount0 = BigInt(cArgs.amount0Collect);
          const collectAmount1 = BigInt(cArgs.amount1Collect);
          // Fees = Collect - DecreaseLiquidity principal
          collectedFees0 = collectAmount0 > decreaseAmount0 ? collectAmount0 - decreaseAmount0 : 0n;
          collectedFees1 = collectAmount1 > decreaseAmount1 ? collectAmount1 - decreaseAmount1 : 0n;
        }

        console.log(`    Found close event at block ${dLog.blockNumber}`);
        return {
          status: "found",
          event: {
            tokenId,
            blockNumber: dLog.blockNumber!,
            transactionHash: dLog.transactionHash!,
            amount0: decreaseAmount0,
            amount1: decreaseAmount1,
            liquidity: BigInt(dArgs.liquidity),
            collectedFees0,
            collectedFees1,
          },
        };
      }
    }

    console.warn(`    Could not find close event for token #${tokenId}`);
    return { status: "not_found" };
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

// === Internal helpers ===

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
