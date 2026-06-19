import { describe, expect, it } from "bun:test";

import type { HypersyncClient } from "@envio-dev/hypersync-client";
import { encodeAbiParameters } from "viem";

import { findCloseEvent, findOpenEvent } from "../chain/events.js";
import { padUint256 } from "../chain/hypersync.js";

type Hex = `0x${string}`;
type OpenClient = Parameters<typeof findOpenEvent>[0];

// ============================================================================
// Constants and helpers
// ============================================================================

const POSITION_MANAGER = "0x3333333333333333333333333333333333333333" as Hex;
const WALLET = "0x4444444444444444444444444444444444444444" as Hex;
const TX_HASH = "0xaaaabbbbccccddddeeeeffffaaaaabbbbccccdddd" as Hex;

const INCREASE_LIQUIDITY_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f" as Hex;
const DECREASE_LIQUIDITY_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4" as Hex;
const COLLECT_TOPIC = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01" as Hex;

interface MockLog {
  transactionHash?: string;
  logIndex?: number;
  blockNumber?: number;
  address?: string;
  data?: string;
  topics?: (string | undefined | null)[];
}

/**
 * Build a mock viem-like Client for fallback tests (getLogs path).
 * When hyperSyncClient is not provided, the code falls back to viem's getLogs.
 */
function mockViemClient(logsToReturn: any[] = []): OpenClient {
  return {
    getBlockNumber: async () => 10_000n,
    getLogs: async () => logsToReturn,
  } as unknown as OpenClient;
}

/**
 * Create a mock IncreaseLiquidity log for HyperSync
 */
function mockIncreaseLiquidityLog(
  tokenId: bigint,
  liquidity: bigint,
  amount0: bigint,
  amount1: bigint,
  blockNumber = 12345,
): MockLog {
  const data = encodeAbiParameters(
    [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
    [liquidity, amount0, amount1],
  );
  return {
    transactionHash: TX_HASH,
    logIndex: 0,
    blockNumber,
    address: POSITION_MANAGER,
    data,
    topics: [INCREASE_LIQUIDITY_TOPIC, padUint256(tokenId)],
  };
}

/**
 * Create a mock DecreaseLiquidity log for HyperSync
 */
function mockDecreaseLiquidityLog(
  tokenId: bigint,
  liquidity: bigint,
  amount0: bigint,
  amount1: bigint,
  blockNumber = 12345,
): MockLog {
  const data = encodeAbiParameters(
    [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
    [liquidity, amount0, amount1],
  );
  return {
    transactionHash: TX_HASH,
    logIndex: 0,
    blockNumber,
    address: POSITION_MANAGER,
    data,
    topics: [DECREASE_LIQUIDITY_TOPIC, padUint256(tokenId)],
  };
}

/**
 * Create a mock Collect log for HyperSync
 */
function mockCollectLog(
  tokenId: bigint,
  recipient: Hex,
  amount0Collect: bigint,
  amount1Collect: bigint,
  blockNumber = 12345,
  logIndex = 1,
): MockLog {
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [recipient, amount0Collect, amount1Collect],
  );
  return {
    transactionHash: TX_HASH,
    logIndex,
    blockNumber,
    address: POSITION_MANAGER,
    data,
    topics: [COLLECT_TOPIC, padUint256(tokenId)],
  };
}

// ============================================================================
// Scenario 1: findOpenEvent SDK path — found
// ============================================================================

describe("findOpenEvent SDK path", () => {
  it("scenario 1: found — returns PositionOpenEvent with correct fields", async () => {
    const tokenId = 123n;
    const liquidity = 1000n;
    const amount0 = 500n;
    const amount1 = 200n;
    const blockNumber = 5000;
    const toBlock = 10_000; // Must match latestBlock passed to findOpenEvent

    // For findOpenEvent, the SDK client is called once
    const hyperSyncClient = {
      get: async (_query: unknown) => ({
        data: {
          logs: [mockIncreaseLiquidityLog(tokenId, liquidity, amount0, amount1, blockNumber)],
          blocks: [{ number: blockNumber, timestamp: 1700000000 }],
          transactions: [],
          traces: [],
        },
        nextBlock: toBlock + 1, // >= toBlock to signal end of pagination
        archiveHeight: toBlock + 1,
      }),
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined, // knownOpenTx
      undefined, // fromBlock
      undefined, // windowBlocks
      BigInt(toBlock), // latestBlock — avoids needing getBlockNumber
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(tokenId);
      expect(result.event.amount0).toBe(amount0);
      expect(result.event.amount1).toBe(amount1);
      expect(result.event.liquidity).toBe(liquidity);
      expect(result.event.blockNumber).toBe(BigInt(blockNumber));
      expect(result.event.transactionHash).toBe(TX_HASH);
    }
  });

  // ============================================================================
  // Scenario 2: findOpenEvent SDK path — not found (empty logs)
  // ============================================================================

  it("scenario 2: not found — SDK returns empty logs page", async () => {
    const tokenId = 999n;
    const toBlock = 10_000;

    const hyperSyncClient = {
      get: async (_query: unknown) => ({
        data: {
          logs: [],
          blocks: [],
          transactions: [],
          traces: [],
        },
        nextBlock: toBlock + 1,
        archiveHeight: toBlock + 1,
      }),
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("not_found");
  });

  // ============================================================================
  // Scenario 3: findOpenEvent SDK path — SDK throws → rpc_error
  // ============================================================================

  it("scenario 3: rpc_error — SDK client throws error", async () => {
    const tokenId = 123n;
    const errorClient = {
      get: async () => {
        throw new Error("SDK connection failed");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      10_000n,
      errorClient,
    );

    expect(result.status).toBe("rpc_error");
  });

  // ============================================================================
  // Scenario 4: findOpenEvent without SDK — viem fallback used
  // ============================================================================

  it("scenario 4: fallback to viem getLogs when no hyperSyncClient provided", async () => {
    const tokenId = 555n;

    // Mock viem client with getLogs that returns empty (not found)
    let getLogsCalled = false;
    const viemClient = {
      getBlockNumber: async () => 10_000n,
      getLogs: async () => {
        getLogsCalled = true;
        return [];
      },
    } as unknown as OpenClient;

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined, // knownOpenTx
      undefined, // fromBlock
      undefined, // windowBlocks
      10_000n, // latestBlock
      undefined, // NO hyperSyncClient — triggers viem path
    );

    expect(getLogsCalled).toBe(true);
    expect(result.status).toBe("not_found");
  });
});

// ============================================================================
// findCloseEvent SDK path tests
// ============================================================================

describe("findCloseEvent SDK path", () => {
  // ============================================================================
  // Scenario 5: findCloseEvent SDK path — found with no Collect logs (fees = 0)
  // ============================================================================

  it("scenario 5: found — DecreaseLiquidity with no Collect logs (zero fees)", async () => {
    const tokenId = 456n;
    const liquidity = 2000n;
    const amount0 = 1000n;
    const amount1 = 3000n;
    const blockNumber = 6000;
    const toBlock = 10_000;

    // findCloseEvent makes TWO calls: one for DecreaseLiquidity, one for Collect
    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [mockDecreaseLiquidityLog(tokenId, liquidity, amount0, amount1, blockNumber)],
              blocks: [{ number: blockNumber, timestamp: 1700001000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch (empty result)
          return {
            data: {
              logs: [],
              blocks: [],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined, // knownCloseTx
      undefined, // fromBlock
      undefined, // windowBlocks
      BigInt(toBlock), // latestBlock
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(tokenId);
      expect(result.event.amount0).toBe(amount0);
      expect(result.event.amount1).toBe(amount1);
      expect(result.event.liquidity).toBe(liquidity);
      expect(result.event.collectedFees0).toBe(0n);
      expect(result.event.collectedFees1).toBe(0n);
      expect(result.event.blockNumber).toBe(BigInt(blockNumber));
      expect(result.event.transactionHash).toBe(TX_HASH);
    }
  });

  // ============================================================================
  // Scenario 6: findCloseEvent SDK path — not found
  // ============================================================================

  it("scenario 6: not found — SDK returns no DecreaseLiquidity logs", async () => {
    const tokenId = 789n;
    const toBlock = 10_000;

    const hyperSyncClient = {
      get: async (_query: unknown) => {
        // Both DecreaseLiquidity and Collect calls return empty
        return {
          data: {
            logs: [],
            blocks: [],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
        };
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("not_found");
  });

  // ============================================================================
  // Scenario 7: findCloseEvent SDK path — found with Collect logs (fees > 0)
  // ============================================================================

  it("scenario 7: found with Collect logs — fees calculated correctly", async () => {
    const tokenId = 321n;
    const liquidity = 5000n;
    const decreaseAmount0 = 2000n;
    const decreaseAmount1 = 4000n;
    // Total collected (principal + fees)
    const collectAmount0 = 2100n; // +100 in fees
    const collectAmount1 = 4250n; // +250 in fees
    const blockNumber = 7000;
    const toBlock = 10_000;

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  blockNumber,
                ),
              ],
              blocks: [{ number: blockNumber, timestamp: 1700002000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch
          return {
            data: {
              logs: [mockCollectLog(tokenId, WALLET, collectAmount0, collectAmount1, blockNumber)],
              blocks: [{ number: blockNumber, timestamp: 1700002000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(tokenId);
      expect(result.event.amount0).toBe(decreaseAmount0);
      expect(result.event.amount1).toBe(decreaseAmount1);
      expect(result.event.liquidity).toBe(liquidity);
      // Fees = Collect - Decrease (0 if negative)
      expect(result.event.collectedFees0).toBe(100n);
      expect(result.event.collectedFees1).toBe(250n);
    }
  });

  // ============================================================================
  // Scenario 8: findCloseEvent SDK path — Collect before close block (bounded)
  // ============================================================================

  it("scenario 8: bounds Collect logs to close block number", async () => {
    const tokenId = 654n;
    const liquidity = 3000n;
    const decreaseAmount0 = 1500n;
    const decreaseAmount1 = 2500n;
    const closeBlockNumber = 8000;
    const collectBlockBefore = 7900;
    const collectBlockAfter = 8100;
    const toBlock = 10_000;

    // Multiple Collect logs: one before close (included), one after close (excluded)
    // Both will be returned by the SDK, but only the before one should be counted
    const collectLogBefore = mockCollectLog(tokenId, WALLET, 1600n, 2600n, collectBlockBefore);
    const collectLogAfter = mockCollectLog(tokenId, WALLET, 2000n, 3000n, collectBlockAfter);

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlockNumber,
                ),
              ],
              blocks: [{ number: closeBlockNumber, timestamp: 1700003000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch — returns BOTH before and after logs
          // But the code should only sum the "before" one (blockNumber <= closeBlockNumber)
          return {
            data: {
              logs: [collectLogBefore, collectLogAfter],
              blocks: [
                { number: collectBlockBefore, timestamp: 1700002900 },
                { number: collectBlockAfter, timestamp: 1700003100 },
              ],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // Only collectLogBefore (blockNumber=7900) should be included in the sum
      // collectLogAfter (blockNumber=8100) should be excluded because it's > closeBlockNumber (8000)
      // So we expect only: 1600n / 2600n
      expect(result.event.collectedFees0).toBe(1600n - decreaseAmount0); // 100n
      expect(result.event.collectedFees1).toBe(2600n - decreaseAmount1); // 100n
    }
  });

  // ============================================================================
  // Scenario A: Adversarial — Multiple Collect logs summed correctly
  // ============================================================================

  it("scenario A: multiple Collect logs are summed correctly", async () => {
    const tokenId = 711n;
    const liquidity = 8000n;
    const decreaseAmount0 = 1000n;
    const decreaseAmount1 = 2000n;
    const closeBlockNumber = 500;
    const toBlock = 10_000;

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlockNumber,
                ),
              ],
              blocks: [{ number: closeBlockNumber, timestamp: 1700000500 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch — returns TWO Collect logs
          // Collect log 1 at block 300: amount0Collect=600n, amount1Collect=1200n
          // Collect log 2 at block 450: amount0Collect=700n, amount1Collect=1100n
          // Total: 600n + 700n = 1300n for amount0, 1200n + 1100n = 2300n for amount1
          return {
            data: {
              logs: [
                mockCollectLog(tokenId, WALLET, 600n, 1200n, 300, 1),
                mockCollectLog(tokenId, WALLET, 700n, 1100n, 450, 2),
              ],
              blocks: [
                { number: 300, timestamp: 1700000300 },
                { number: 450, timestamp: 1700000450 },
              ],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // totalCollect0 = 1300n, totalCollect1 = 2300n
      // fees0 = 1300n - 1000n = 300n, fees1 = 2300n - 2000n = 300n
      expect(result.event.collectedFees0).toBe(300n);
      expect(result.event.collectedFees1).toBe(300n);
    }
  });

  // ============================================================================
  // Scenario B: Adversarial — Collect < Decrease (negative clamp to 0)
  // ============================================================================

  it("scenario B: Collect amounts less than Decrease amounts are clamped to zero fees", async () => {
    const tokenId = 822n;
    const liquidity = 5000n;
    const decreaseAmount0 = 2000n;
    const decreaseAmount1 = 3000n;
    const closeBlockNumber = 600;
    const toBlock = 10_000;

    // Collect log with amounts LESS than decrease amounts
    const collectLog = mockCollectLog(tokenId, WALLET, 500n, 1000n, 550);

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlockNumber,
                ),
              ],
              blocks: [{ number: closeBlockNumber, timestamp: 1700000600 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch
          return {
            data: {
              logs: [collectLog],
              blocks: [{ number: 550, timestamp: 1700000550 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // Collect < Decrease, so fees should be clamped to 0 (max(0, collect - decrease))
      // fees0 = max(0, 500n - 2000n) = 0n
      // fees1 = max(0, 1000n - 3000n) = 0n
      expect(result.event.collectedFees0).toBe(0n);
      expect(result.event.collectedFees1).toBe(0n);
    }
  });

  // ============================================================================
  // Scenario C: Adversarial — All Collect logs are after close block (zero fees)
  // ============================================================================

  it("scenario C: all Collect logs after close block are excluded, resulting in zero fees", async () => {
    const tokenId = 933n;
    const liquidity = 4000n;
    const decreaseAmount0 = 1000n;
    const decreaseAmount1 = 2000n;
    const closeBlockNumber = 1000;
    const toBlock = 10_000;

    // Collect log AFTER close block (should be excluded)
    const collectLogAfter = mockCollectLog(tokenId, WALLET, 2000n, 4000n, 1001);

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          // First call: DecreaseLiquidity fetch
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlockNumber,
                ),
              ],
              blocks: [{ number: closeBlockNumber, timestamp: 1700001000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          // Second call: Collect fetch — returns a log after close block
          // But the code should exclude it (blockNumber > closeBlockNumber)
          return {
            data: {
              logs: [collectLogAfter],
              blocks: [{ number: 1001, timestamp: 1700001001 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // All Collect logs are excluded (blockNumber > closeBlockNumber)
      // So totalCollect0 = 0n, totalCollect1 = 0n
      // fees0 = max(0, 0n - 1000n) = 0n
      // fees1 = max(0, 0n - 2000n) = 0n
      expect(result.event.collectedFees0).toBe(0n);
      expect(result.event.collectedFees1).toBe(0n);
    }
  });
});

// ============================================================================
// Fast-path (knownCloseTx) + SDK Collect scan
// ============================================================================

describe("findCloseEvent fast path with SDK Collect scan", () => {
  it("scenario E: knownCloseTx + prior Collect event counted when entry_block is unknown", async () => {
    // Regression for position #482555:
    //   - A separate Collect tx happens at block 5000 (partial fee claim).
    //   - The close tx happens at block 5100 (DecreaseLiquidity + Collect).
    //   - entry_block is unknown (fromBlock = undefined) → falls back to window.
    //   - Both Collect events must be summed; fees = totalCollect - principal.
    const tokenId = 482555n;
    const liquidity = 1000n;
    const decreaseAmount0 = 35_000n;
    const decreaseAmount1 = 358_000n;
    // Prior partial claim (pure fees, no principal change)
    const priorCollect0 = 1_000n;
    const priorCollect1 = 9_000n;
    // Close-tx Collect: principal + remaining accrued fees
    const closeTxCollect0 = 35_500n; // 35_000 principal + 500 fees
    const closeTxCollect1 = 358_100n; // 358_000 principal + 100 fees
    const priorBlock = 5000;
    const closeBlock = 5100;
    const toBlock = 10_000;
    const CLOSE_TX = "0xcc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00cc00" as Hex;

    // Viem client: provides the close tx receipt (DecreaseLiquidity + Collect)
    const closeReceipt = {
      blockNumber: BigInt(closeBlock),
      transactionHash: CLOSE_TX,
      logs: [
        mockDecreaseLiquidityLog(tokenId, liquidity, decreaseAmount0, decreaseAmount1, closeBlock),
        mockCollectLog(tokenId, WALLET, closeTxCollect0, closeTxCollect1, closeBlock, 1),
      ],
    };
    type CloseClient = Parameters<typeof findCloseEvent>[0];
    const viemClient = {
      getBlockNumber: async () => BigInt(toBlock),
      getTransactionReceipt: async () => closeReceipt,
      getLogs: async () => {
        throw new Error("getLogs should not be called in SDK fast path");
      },
    } as unknown as CloseClient;

    // HyperSync: first call returns decreases, second returns both Collect logs.
    let sdkCallCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        sdkCallCount++;
        if (sdkCallCount === 1) {
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlock,
                ),
              ],
              blocks: [{ number: closeBlock, timestamp: 1700000100 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        return {
          data: {
            logs: [
              mockCollectLog(tokenId, WALLET, priorCollect0, priorCollect1, priorBlock, 0),
              mockCollectLog(tokenId, WALLET, closeTxCollect0, closeTxCollect1, closeBlock, 1),
            ],
            blocks: [
              { number: priorBlock, timestamp: 1700000000 },
              { number: closeBlock, timestamp: 1700000100 },
            ],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
        };
      },
    } as unknown as HypersyncClient;

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      CLOSE_TX, // knownCloseTx → fast path
      undefined, // fromBlock unknown (no entry_block in DB)
      undefined, // default window
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(tokenId);
      expect(result.event.amount0).toBe(decreaseAmount0);
      expect(result.event.amount1).toBe(decreaseAmount1);
      // totalCollect0 = 1_000 + 35_500 = 36_500; fees0 = 36_500 - 35_000 = 1_500
      expect(result.event.collectedFees0).toBe(1_500n);
      // totalCollect1 = 9_000 + 358_100 = 367_100; fees1 = 367_100 - 358_000 = 9_100
      expect(result.event.collectedFees1).toBe(9_100n);
    }
  });

  it("scenario F: knownCloseTx + no prior Collect events → fees only from close tx", async () => {
    // When there are no prior fee claims, the result must match the old behaviour.
    const tokenId = 100n;
    const liquidity = 500n;
    const decreaseAmount0 = 10_000n;
    const decreaseAmount1 = 5_000n;
    const closeTxCollect0 = 10_200n; // principal + 200 fees
    const closeTxCollect1 = 5_050n; // principal + 50 fees
    const closeBlock = 800;
    const toBlock = 10_000;
    const CLOSE_TX = "0xdd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00dd00" as Hex;

    const closeReceipt = {
      blockNumber: BigInt(closeBlock),
      transactionHash: CLOSE_TX,
      logs: [
        mockDecreaseLiquidityLog(tokenId, liquidity, decreaseAmount0, decreaseAmount1, closeBlock),
        mockCollectLog(tokenId, WALLET, closeTxCollect0, closeTxCollect1, closeBlock, 1),
      ],
    };
    type CloseClient = Parameters<typeof findCloseEvent>[0];
    const viemClient = {
      getBlockNumber: async () => BigInt(toBlock),
      getTransactionReceipt: async () => closeReceipt,
      getLogs: async () => {
        throw new Error("getLogs should not be called");
      },
    } as unknown as CloseClient;

    // HyperSync: first call returns decreases, second returns only the close-tx Collect.
    let sdkCallCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        sdkCallCount++;
        if (sdkCallCount === 1) {
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  closeBlock,
                ),
              ],
              blocks: [{ number: closeBlock, timestamp: 1700000800 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        return {
          data: {
            logs: [
              mockCollectLog(tokenId, WALLET, closeTxCollect0, closeTxCollect1, closeBlock, 1),
            ],
            blocks: [{ number: closeBlock, timestamp: 1700000800 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
        };
      },
    } as unknown as HypersyncClient;

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      CLOSE_TX,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // Only close-tx fees: 10_200 - 10_000 = 200; 5_050 - 5_000 = 50
      expect(result.event.collectedFees0).toBe(200n);
      expect(result.event.collectedFees1).toBe(50n);
    }
  });
});

// ============================================================================
// Scenario D: Adversarial — Collect log with extra trailing topic (strict:false robustness)
// ============================================================================

describe("decodeHyperSyncLog robustness", () => {
  it("scenario D: Collect log with extra trailing non-empty topic still decodes fees correctly", async () => {
    // Some SDK implementations pad the topics array with extra entries.
    // With strict:false, decodeEventLog should tolerate the extra topic and
    // still return correct amount0Collect / amount1Collect values.
    const tokenId = 777n;
    const liquidity = 1000n;
    const decreaseAmount0 = 500n;
    const decreaseAmount1 = 800n;
    const collectAmount0 = 600n; // 100n fees
    const collectAmount1 = 900n; // 100n fees
    const blockNumber = 9000;
    const toBlock = 10_000;

    // Build a Collect log whose topics array has an extra bogus topic[2]
    // (simulates a buggy SDK response or a contract variant where recipient is indexed)
    const collectLogWithExtraTopic = {
      ...mockCollectLog(tokenId, WALLET, collectAmount0, collectAmount1, blockNumber),
      topics: [
        COLLECT_TOPIC,
        padUint256(tokenId),
        // Extra topic — strict:true would throw; strict:false should ignore it
        "0x" + "aa".repeat(32),
      ],
    };

    let callCount = 0;
    const hyperSyncClient = {
      get: async (_query: unknown) => {
        callCount++;
        if (callCount === 1) {
          return {
            data: {
              logs: [
                mockDecreaseLiquidityLog(
                  tokenId,
                  liquidity,
                  decreaseAmount0,
                  decreaseAmount1,
                  blockNumber,
                ),
              ],
              blocks: [{ number: blockNumber, timestamp: 1700009000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        } else if (callCount === 2) {
          return {
            data: {
              logs: [collectLogWithExtraTopic],
              blocks: [{ number: blockNumber, timestamp: 1700009000 }],
              transactions: [],
              traces: [],
            },
            nextBlock: toBlock + 1,
            archiveHeight: toBlock + 1,
          };
        }
        throw new Error("Unexpected extra SDK call");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    if (result.status === "found") {
      // strict:false allows decoding despite the extra topic → fees should be non-zero
      expect(result.event.collectedFees0).toBe(100n);
      expect(result.event.collectedFees1).toBe(100n);
    }
  });
});

// ============================================================================
// Edge cases and error propagation
// ============================================================================

describe("SDK path edge cases", () => {
  it("returns rpc_error when SDK throws during findCloseEvent", async () => {
    const tokenId = 111n;
    const errorClient = {
      get: async () => {
        throw new Error("Network timeout");
      },
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findCloseEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      10_000n,
      errorClient,
    );

    expect(result.status).toBe("rpc_error");
  });

  it("handles logs with empty topics gracefully", async () => {
    const tokenId = 222n;
    const toBlock = 10_000;

    // Log with missing/empty topics
    const malformedLog: MockLog = {
      transactionHash: TX_HASH,
      logIndex: 0,
      blockNumber: 5000,
      address: POSITION_MANAGER,
      data: "0x", // empty data
      topics: ["", ""], // malformed topics
    };

    const hyperSyncClient = {
      get: async (_query: unknown) => ({
        data: {
          logs: [malformedLog],
          blocks: [{ number: 5000, timestamp: 1700000000 }],
          transactions: [],
          traces: [],
        },
        nextBlock: toBlock + 1,
        archiveHeight: toBlock + 1,
      }),
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    // Should return not_found due to malformed log
    expect(result.status).toBe("not_found");
  });

  it("verifies tokenId matches in SDK results (defensive check)", async () => {
    const requestedTokenId = 500n;
    const returnedTokenId = 501n; // Different!
    const toBlock = 10_000;

    // SDK filters by topic1, but we verify the decoded tokenId matches
    const hyperSyncClient = {
      get: async (_query: unknown) => ({
        data: {
          logs: [mockIncreaseLiquidityLog(returnedTokenId, 1000n, 500n, 200n, 5000)],
          blocks: [{ number: 5000, timestamp: 1700000000 }],
          transactions: [],
          traces: [],
        },
        nextBlock: toBlock + 1,
        archiveHeight: toBlock + 1,
      }),
    } as unknown as HypersyncClient;

    const viemClient = mockViemClient();

    const result = await findOpenEvent(
      viemClient,
      POSITION_MANAGER,
      requestedTokenId,
      WALLET,
      undefined,
      undefined,
      undefined,
      BigInt(toBlock),
      hyperSyncClient,
    );

    // Should return not_found because tokenId doesn't match
    expect(result.status).toBe("not_found");
  });
});
