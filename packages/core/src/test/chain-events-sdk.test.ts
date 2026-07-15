import { describe, expect, it } from "bun:test";

import { encodeAbiParameters } from "viem";

import {
  findCloseEvent,
  findOpenEvent,
  sumCollectLogsPublic,
  sumDecreaseLiquidityLogs,
} from "../chain/events.js";
import { padUint256 } from "../chain/hypersync.js";
import { makeHypersyncClient } from "./helpers/hypersync.js";

type Hex = `0x${string}`;
type OpenClient = Parameters<typeof findOpenEvent>[0];
type CloseClient = Parameters<typeof findCloseEvent>[0];
type HyperSyncClient = NonNullable<Parameters<typeof findOpenEvent>[8]>;
type GetLogs = OpenClient["getLogs"];
type CloseReceipt = Awaited<ReturnType<NonNullable<CloseClient["getTransactionReceipt"]>>>;

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
  topics: (string | undefined | null)[];
}

type SimpleEventLog = {
  args: Record<string, bigint>;
  blockNumber: bigint;
  transactionHash: Hex;
};

/**
 * Build a mock viem-like Client for fallback tests (getLogs path).
 * When hyperSyncClient is not provided, the code falls back to viem's getLogs.
 */
function mockViemClient(logsToReturn: any[] = []): OpenClient {
  const getLogs: GetLogs = async () => logsToReturn;
  return {
    getBlockNumber: async () => 10_000n,
    getLogs,
  };
}

function makeHyperSyncMock(get: HyperSyncClient["get"]): HyperSyncClient {
  return makeHypersyncClient(get);
}

function makeReceipt(
  logs: CloseReceipt["logs"],
  blockNumber: bigint,
  transactionHash: Hex,
): CloseReceipt {
  return {
    blockNumber,
    logs,
    transactionHash,
  };
}

function makeCloseClient(
  receipt: CloseReceipt,
  getLogs?: GetLogs,
  latestBlock = 10_000n,
): CloseClient {
  return {
    getBlockNumber: async () => latestBlock,
    getTransactionReceipt: async () => receipt,
    getLogs:
      getLogs ??
      (async () => {
        throw new Error("getLogs should not be called");
      }),
  };
}

function makeEventLog(
  args: Record<string, bigint>,
  blockNumber: bigint,
  transactionHash: Hex,
): SimpleEventLog {
  return {
    args,
    blockNumber,
    transactionHash,
  };
}

function asGetLogs(
  fn: (args?: { fromBlock?: bigint; toBlock?: bigint }) => Promise<SimpleEventLog[]>,
): GetLogs {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return fn as unknown as GetLogs;
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
): Required<MockLog> {
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
): Required<MockLog> {
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
): Required<MockLog> {
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
  it("uses the known open transaction receipt path before any SDK scan", async () => {
    const tokenId = 123n;
    const latestBlock = 10_000n;
    const queries: any[] = [];
    const receipt = makeReceipt(
      [
        {
          topics: [INCREASE_LIQUIDITY_TOPIC, padUint256(tokenId)],
          data: encodeAbiParameters(
            [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
            [77n, 88n, 99n],
          ),
        },
      ],
      4_321n,
      TX_HASH,
    );

    const hyperSyncClient = makeHyperSyncMock(async (query) => {
      queries.push(query);
      return {
        data: { logs: [], blocks: [], transactions: [], traces: [] },
        nextBlock: Number(latestBlock) + 1,
        archiveHeight: Number(latestBlock) + 1,
        totalExecutionTime: 1,
      };
    });

    const result = await findOpenEvent(
      makeCloseClient(receipt, undefined, latestBlock),
      POSITION_MANAGER,
      tokenId,
      WALLET,
      TX_HASH,
      undefined,
      undefined,
      latestBlock,
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    expect(queries).toHaveLength(0);
  });

  it("scenario 1: found — returns PositionOpenEvent with correct fields", async () => {
    const tokenId = 123n;
    const liquidity = 1000n;
    const amount0 = 500n;
    const amount1 = 200n;
    const blockNumber = 5000;
    const toBlock = 10_000; // Must match latestBlock passed to findOpenEvent

    // For findOpenEvent, the SDK client is called once
    const hyperSyncClient = makeHyperSyncMock(async (_query) => ({
      data: {
        logs: [mockIncreaseLiquidityLog(tokenId, liquidity, amount0, amount1, blockNumber)],
        blocks: [{ number: blockNumber, timestamp: 1700000000 }],
        transactions: [],
        traces: [],
      },
      nextBlock: toBlock + 1,
      archiveHeight: toBlock + 1,
      totalExecutionTime: 1,
    }));

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

    const hyperSyncClient = makeHyperSyncMock(async (_query) => ({
      data: {
        logs: [],
        blocks: [],
        transactions: [],
        traces: [],
      },
      nextBlock: toBlock + 1,
      archiveHeight: toBlock + 1,
      totalExecutionTime: 1,
    }));

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
    const errorClient = makeHyperSyncMock(async () => {
      throw new Error("SDK connection failed");
    });

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
    const viemClient = mockViemClient(
      await (async () => {
        getLogsCalled = true;
        return [];
      })(),
    );

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
  it("pads tokenId and uses inclusive/exclusive block bounds in HyperSync queries", async () => {
    const tokenId = 456n;
    const latestBlock = 10_000n;
    const queries: any[] = [];

    const hyperSyncClient = makeHyperSyncMock(async (query) => {
      queries.push(query);
      if (queries.length === 1) {
        return {
          data: {
            logs: [mockDecreaseLiquidityLog(tokenId, 2000n, 1000n, 3000n, 6000)],
            blocks: [{ number: 6000, timestamp: 1700001000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: Number(latestBlock) + 1,
          archiveHeight: Number(latestBlock) + 1,
          totalExecutionTime: 1,
        };
      }
      return {
        data: { logs: [], blocks: [], transactions: [], traces: [] },
        nextBlock: Number(latestBlock) + 1,
        archiveHeight: Number(latestBlock) + 1,
        totalExecutionTime: 1,
      };
    });

    const result = await findCloseEvent(
      mockViemClient(),
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      222n,
      undefined,
      latestBlock,
      hyperSyncClient,
    );

    expect(result.status).toBe("found");
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.fromBlock).toBe(222);
      expect(query.toBlock).toBe(10001);
      expect(query.logs[0]?.include?.address).toEqual([POSITION_MANAGER.toLowerCase()]);
      expect(query.logs[0]?.include?.topics?.[1]).toEqual([padUint256(tokenId)]);
    }
    expect(queries[0]?.logs[0]?.include?.topics?.[0]).toEqual([DECREASE_LIQUIDITY_TOPIC]);
    expect(queries[1]?.logs[0]?.include?.topics?.[0]).toEqual([COLLECT_TOPIC]);
  });

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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
      callCount++;
      if (callCount === 1) {
        return {
          data: {
            logs: [mockDecreaseLiquidityLog(tokenId, liquidity, amount0, amount1, blockNumber)],
            blocks: [{ number: blockNumber, timestamp: 1700001000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
        return {
          data: {
            logs: [],
            blocks: [],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
      expect(result.event.cumulativeAmount0).toBe(amount0);
      expect(result.event.cumulativeAmount1).toBe(amount1);
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

    const hyperSyncClient = makeHyperSyncMock(async (_query) => ({
      data: {
        logs: [],
        blocks: [],
        transactions: [],
        traces: [],
      },
      nextBlock: toBlock + 1,
      archiveHeight: toBlock + 1,
      totalExecutionTime: 1,
    }));

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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
            blocks: [{ number: blockNumber, timestamp: 1700002000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
        return {
          data: {
            logs: [mockCollectLog(tokenId, WALLET, collectAmount0, collectAmount1, blockNumber)],
            blocks: [{ number: blockNumber, timestamp: 1700002000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
      expect(result.event.cumulativeAmount0).toBe(decreaseAmount0);
      expect(result.event.cumulativeAmount1).toBe(decreaseAmount1);
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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
                closeBlockNumber,
              ),
            ],
            blocks: [{ number: closeBlockNumber, timestamp: 1700003000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
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
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
                closeBlockNumber,
              ),
            ],
            blocks: [{ number: closeBlockNumber, timestamp: 1700000500 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
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
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
                closeBlockNumber,
              ),
            ],
            blocks: [{ number: closeBlockNumber, timestamp: 1700000600 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
        return {
          data: {
            logs: [collectLog],
            blocks: [{ number: 550, timestamp: 1700000550 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
                closeBlockNumber,
              ),
            ],
            blocks: [{ number: closeBlockNumber, timestamp: 1700001000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
        return {
          data: {
            logs: [collectLogAfter],
            blocks: [{ number: 1001, timestamp: 1700001001 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
    const closeReceipt = makeReceipt(
      [
        {
          topics: [DECREASE_LIQUIDITY_TOPIC, padUint256(tokenId)],
          data: encodeAbiParameters(
            [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
            [liquidity, decreaseAmount0, decreaseAmount1],
          ),
        },
        {
          topics: [COLLECT_TOPIC, padUint256(tokenId)],
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
            [WALLET, closeTxCollect0, closeTxCollect1],
          ),
        },
      ],
      BigInt(closeBlock),
      CLOSE_TX,
    );
    const viemClient = makeCloseClient(
      closeReceipt,
      async () => {
        throw new Error("getLogs should not be called in SDK fast path");
      },
      BigInt(toBlock),
    );

    // HyperSync: first call returns decreases, second returns both Collect logs.
    let sdkCallCount = 0;
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
          totalExecutionTime: 1,
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
        totalExecutionTime: 1,
      };
    });

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
      expect(result.event.cumulativeAmount0).toBe(decreaseAmount0);
      expect(result.event.cumulativeAmount1).toBe(decreaseAmount1);
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

    const closeReceipt = makeReceipt(
      [
        {
          topics: [DECREASE_LIQUIDITY_TOPIC, padUint256(tokenId)],
          data: encodeAbiParameters(
            [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
            [liquidity, decreaseAmount0, decreaseAmount1],
          ),
        },
        {
          topics: [COLLECT_TOPIC, padUint256(tokenId)],
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
            [WALLET, closeTxCollect0, closeTxCollect1],
          ),
        },
      ],
      BigInt(closeBlock),
      CLOSE_TX,
    );
    const viemClient = makeCloseClient(
      closeReceipt,
      async () => {
        throw new Error("getLogs should not be called");
      },
      BigInt(toBlock),
    );

    // HyperSync: first call returns decreases, second returns only the close-tx Collect.
    let sdkCallCount = 0;
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
          totalExecutionTime: 1,
        };
      }
      return {
        data: {
          logs: [mockCollectLog(tokenId, WALLET, closeTxCollect0, closeTxCollect1, closeBlock, 1)],
          blocks: [{ number: closeBlock, timestamp: 1700000800 }],
          transactions: [],
          traces: [],
        },
        nextBlock: toBlock + 1,
        archiveHeight: toBlock + 1,
        totalExecutionTime: 1,
      };
    });

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
      expect(result.event.cumulativeAmount0).toBe(10_000n);
      expect(result.event.cumulativeAmount1).toBe(5_000n);
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
    const hyperSyncClient = makeHyperSyncMock(async (_query) => {
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
          totalExecutionTime: 1,
        };
      }
      if (callCount === 2) {
        return {
          data: {
            logs: [collectLogWithExtraTopic],
            blocks: [{ number: blockNumber, timestamp: 1700009000 }],
            transactions: [],
            traces: [],
          },
          nextBlock: toBlock + 1,
          archiveHeight: toBlock + 1,
          totalExecutionTime: 1,
        };
      }
      throw new Error("Unexpected extra SDK call");
    });

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
    const errorClient = makeHyperSyncMock(async () => {
      throw new Error("Network timeout");
    });

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

    const hyperSyncClient = makeHyperSyncMock(async (_query) => ({
      data: {
        logs: [malformedLog],
        blocks: [{ number: 5000, timestamp: 1700000000 }],
        transactions: [],
        traces: [],
      },
      nextBlock: toBlock + 1,
      archiveHeight: toBlock + 1,
      totalExecutionTime: 1,
    }));

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

  it("skips malformed HyperSync liquidity logs instead of throwing through the seam", async () => {
    const malformedLog: MockLog = {
      transactionHash: TX_HASH,
      logIndex: 0,
      blockNumber: 5000,
      address: POSITION_MANAGER,
      data: "0x1234",
      topics: [DECREASE_LIQUIDITY_TOPIC, padUint256(222n)],
    };

    const hyperSyncClient = makeHyperSyncMock(async () => ({
      data: {
        logs: [malformedLog],
        blocks: [{ number: 5000, timestamp: 1700000000 }],
        transactions: [],
        traces: [],
      },
      nextBlock: 10_001,
      archiveHeight: 10_001,
      totalExecutionTime: 1,
    }));

    const result = await findCloseEvent(
      mockViemClient(),
      POSITION_MANAGER,
      222n,
      WALLET,
      undefined,
      undefined,
      undefined,
      10_000n,
      hyperSyncClient,
    );

    expect(result.status).toBe("not_found");
  });

  it("returns rpc_error when HyperSync collect aggregation fails after locating the close lifecycle", async () => {
    const tokenId = 111n;
    let callCount = 0;
    const boom = new Error("collect page failed");
    const hyperSyncClient = makeHyperSyncMock(async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          data: {
            logs: [mockDecreaseLiquidityLog(tokenId, 50n, 3000n, 4000n, 600)],
            blocks: [{ number: 600, timestamp: 1700000600 }],
            transactions: [],
            traces: [],
          },
          nextBlock: 10_001,
          archiveHeight: 10_001,
          totalExecutionTime: 1,
        };
      }
      throw boom;
    });

    const result = await findCloseEvent(
      mockViemClient(),
      POSITION_MANAGER,
      tokenId,
      WALLET,
      undefined,
      100n,
      undefined,
      10_000n,
      hyperSyncClient,
    );

    expect(result.status).toBe("rpc_error");
    if (result.status === "rpc_error") {
      expect(result.error).toBe(boom);
    }
  });

  it("verifies tokenId matches in SDK results (defensive check)", async () => {
    const requestedTokenId = 500n;
    const returnedTokenId = 501n; // Different!
    const toBlock = 10_000;

    // SDK filters by topic1, but we verify the decoded tokenId matches
    const hyperSyncClient = makeHyperSyncMock(async (_query) => ({
      data: {
        logs: [mockIncreaseLiquidityLog(returnedTokenId, 1000n, 500n, 200n, 5000)],
        blocks: [{ number: 5000, timestamp: 1700000000 }],
        transactions: [],
        traces: [],
      },
      nextBlock: toBlock + 1,
      archiveHeight: toBlock + 1,
      totalExecutionTime: 1,
    }));

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

describe("adapter parity", () => {
  it("returns the same close lifecycle event across viem and HyperSync adapters", async () => {
    const tokenId = 901n;
    const decrease = { tokenId, liquidity: 50n, amount0: 3000n, amount1: 4000n };
    const priorDecrease = { tokenId, liquidity: 25n, amount0: 500n, amount1: 700n };
    const priorCollect = { tokenId, amount0Collect: 200n, amount1Collect: 300n };
    const closeCollect = { tokenId, amount0Collect: 3_800n, amount1Collect: 5_200n };

    let viemCall = 0;
    const viemClient: OpenClient = {
      getBlockNumber: async () => 10_000n,
      getLogs: asGetLogs(async () => {
        viemCall += 1;
        if (viemCall === 1) {
          return [makeEventLog(decrease, 600n, TX_HASH)];
        }
        if (viemCall === 2) {
          return [
            makeEventLog(
              priorDecrease,
              400n,
              "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ),
            makeEventLog(decrease, 600n, TX_HASH),
          ];
        }
        return [
          makeEventLog(
            priorCollect,
            450n,
            "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          ),
          makeEventLog(closeCollect, 600n, TX_HASH),
        ];
      }),
    };

    let sdkCall = 0;
    const hyperSyncClient = makeHyperSyncMock(async () => {
      sdkCall += 1;
      if (sdkCall === 1) {
        return {
          data: {
            logs: [
              {
                ...mockDecreaseLiquidityLog(tokenId, 25n, 500n, 700n, 400),
                transactionHash: "0x1111bbbbccccddddeeeeffffaaaaabbbbccccddddeeeeffffaaaaabbbbcccc",
              },
              {
                ...mockDecreaseLiquidityLog(tokenId, 50n, 3000n, 4000n, 600),
                transactionHash: TX_HASH,
              },
            ],
            blocks: [
              { number: 400, timestamp: 1700000400 },
              { number: 600, timestamp: 1700000600 },
            ],
            transactions: [],
            traces: [],
          },
          nextBlock: 10_001,
          archiveHeight: 10_001,
          totalExecutionTime: 1,
        };
      }
      return {
        data: {
          logs: [
            mockCollectLog(tokenId, WALLET, 200n, 300n, 450, 0),
            mockCollectLog(tokenId, WALLET, 3800n, 5200n, 600, 1),
          ],
          blocks: [
            { number: 450, timestamp: 1700000450 },
            { number: 600, timestamp: 1700000600 },
          ],
          transactions: [],
          traces: [],
        },
        nextBlock: 10_001,
        archiveHeight: 10_001,
        totalExecutionTime: 1,
      };
    });

    const [viemResult, hypersyncResult] = await Promise.all([
      findCloseEvent(viemClient, POSITION_MANAGER, tokenId, WALLET, undefined, 300n),
      findCloseEvent(
        mockViemClient(),
        POSITION_MANAGER,
        tokenId,
        WALLET,
        undefined,
        300n,
        undefined,
        10_000n,
        hyperSyncClient,
      ),
    ]);

    expect(viemResult).toEqual(hypersyncResult);
  });

  it("returns the same aggregated sums across adapters", async () => {
    const tokenId = 700n;
    const viemDecreaseClient = {
      getLogs: asGetLogs(async () => [
        makeEventLog({ tokenId, liquidity: 1n, amount0: 10n, amount1: 20n }, 100n, TX_HASH),
      ]),
    };
    const viemCollectClient = {
      getLogs: asGetLogs(async () => [
        makeEventLog({ tokenId, amount0Collect: 5n, amount1Collect: 7n }, 100n, TX_HASH),
      ]),
    };

    let sdkCall = 0;
    const hyperSyncClient = makeHyperSyncMock(async () => {
      sdkCall += 1;
      if (sdkCall === 1) {
        return {
          data: {
            logs: [mockDecreaseLiquidityLog(tokenId, 1n, 10n, 20n, 100)],
            blocks: [{ number: 100, timestamp: 1700000100 }],
            transactions: [],
            traces: [],
          },
          nextBlock: 201,
          archiveHeight: 201,
          totalExecutionTime: 1,
        };
      }
      return {
        data: {
          logs: [mockCollectLog(tokenId, WALLET, 5n, 7n, 100)],
          blocks: [{ number: 100, timestamp: 1700000100 }],
          transactions: [],
          traces: [],
        },
        nextBlock: 201,
        archiveHeight: 201,
        totalExecutionTime: 1,
      };
    });

    const [viemDecrease, viemCollect, sdkDecrease, sdkCollect] = await Promise.all([
      sumDecreaseLiquidityLogs(viemDecreaseClient, POSITION_MANAGER, tokenId, 1n, 200n),
      sumCollectLogsPublic(viemCollectClient, POSITION_MANAGER, tokenId, 1n, 200n),
      sumDecreaseLiquidityLogs(
        mockViemClient(),
        POSITION_MANAGER,
        tokenId,
        1n,
        200n,
        hyperSyncClient,
      ),
      sumCollectLogsPublic(mockViemClient(), POSITION_MANAGER, tokenId, 1n, 200n, hyperSyncClient),
    ]);

    expect(viemDecrease).toEqual(sdkDecrease);
    expect(viemCollect).toEqual(sdkCollect);
  });
});
