import { describe, expect, it } from "bun:test";

import { encodeAbiParameters, type TransactionReceipt } from "viem";

import { findCloseEvent, findCloseEventFromTx, findOpenEvent } from "../chain/events.js";

type Hex = `0x${string}`;
type CloseClient = Parameters<typeof findCloseEventFromTx>[0];

const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Hex;

const DECREASE_LIQUIDITY_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4" as Hex;
const COLLECT_TOPIC = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01" as Hex;

function tokenTopic(tokenId: bigint): Hex {
  return `0x${tokenId.toString(16).padStart(64, "0")}` as Hex;
}

function decreaseLog(tokenId: bigint, amount0: bigint, amount1: bigint, liquidity = 999n) {
  return {
    topics: [DECREASE_LIQUIDITY_TOPIC, tokenTopic(tokenId)],
    data: encodeAbiParameters(
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
      [liquidity, amount0, amount1],
    ),
  };
}

function collectLog(tokenId: bigint, amount0: bigint, amount1: bigint) {
  return {
    topics: [COLLECT_TOPIC, tokenTopic(tokenId)],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [RECIPIENT, amount0, amount1],
    ),
  };
}

function clientForLogs(
  logs: Array<ReturnType<typeof decreaseLog> | ReturnType<typeof collectLog>>,
) {
  const receipt = {
    blockNumber: 458834n,
    transactionHash: TX_HASH,
    logs,
  } as unknown as TransactionReceipt;

  return {
    getTransactionReceipt: async () => receipt,
  } as unknown as CloseClient;
}

describe("findCloseEventFromTx", () => {
  it("decodes the observed close shape with DecreaseLiquidity followed by Collect", async () => {
    const event = await findCloseEventFromTx(
      clientForLogs([decreaseLog(123n, 1000n, 2000n, 50n), collectLog(123n, 1010n, 2050n)]),
      TX_HASH,
      123n,
    );

    expect(event).toEqual({
      tokenId: 123n,
      blockNumber: 458834n,
      transactionHash: TX_HASH,
      amount0: 1000n,
      amount1: 2000n,
      liquidity: 50n,
      collectedFees0: 10n,
      collectedFees1: 50n,
    });
  });

  it("decodes fees when Collect appears before DecreaseLiquidity", async () => {
    const event = await findCloseEventFromTx(
      clientForLogs([collectLog(123n, 1500n, 2600n), decreaseLog(123n, 1000n, 2000n)]),
      TX_HASH,
      123n,
    );

    expect(event?.amount0).toBe(1000n);
    expect(event?.amount1).toBe(2000n);
    expect(event?.collectedFees0).toBe(500n);
    expect(event?.collectedFees1).toBe(600n);
  });

  it("returns zero fees when Collect equals the DecreaseLiquidity principal", async () => {
    const event = await findCloseEventFromTx(
      clientForLogs([decreaseLog(123n, 1000n, 2000n), collectLog(123n, 1000n, 2000n)]),
      TX_HASH,
      123n,
    );

    expect(event?.amount0).toBe(1000n);
    expect(event?.amount1).toBe(2000n);
    expect(event?.collectedFees0).toBe(0n);
    expect(event?.collectedFees1).toBe(0n);
  });

  it("subtracts principal from Collect amounts to return raw collected fees", async () => {
    const event = await findCloseEventFromTx(
      clientForLogs([decreaseLog(123n, 10_000n, 20_000n), collectLog(123n, 10_123n, 20_456n)]),
      TX_HASH,
      123n,
    );

    expect(event?.amount0).toBe(10_000n);
    expect(event?.amount1).toBe(20_000n);
    expect(event?.collectedFees0).toBe(123n);
    expect(event?.collectedFees1).toBe(456n);
  });

  it("ignores Collect logs for other token IDs", async () => {
    const event = await findCloseEventFromTx(
      clientForLogs([
        collectLog(999n, 10_000n, 20_000n),
        decreaseLog(123n, 1000n, 2000n),
        collectLog(123n, 1001n, 2002n),
      ]),
      TX_HASH,
      123n,
    );

    expect(event?.amount0).toBe(1000n);
    expect(event?.amount1).toBe(2000n);
    expect(event?.collectedFees0).toBe(1n);
    expect(event?.collectedFees1).toBe(2n);
  });
});

// === Scan window computation (slow-path getLogs startBlock) ===

const POSITION_MANAGER = "0x3333333333333333333333333333333333333333" as Hex;
const WALLET = "0x4444444444444444444444444444444444444444" as Hex;

type OpenClient = Parameters<typeof findOpenEvent>[0];

/**
 * Mock client that exposes a controllable latestBlock and captures every
 * getLogs call's fromBlock/toBlock. getLogs always returns [] so the scan
 * completes (returns null) without finding an event.
 */
function windowProbeClient(latestBlock: bigint) {
  const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  const client = {
    getBlockNumber: async () => latestBlock,
    getLogs: async (args: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock });
      return [];
    },
  } as unknown as OpenClient;
  return { client, calls };
}

describe("findOpenEvent scan window computation", () => {
  it("default window: chain younger than window clamps startBlock to 1n", async () => {
    const { client, calls } = windowProbeClient(500n);

    const result = await findOpenEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fromBlock).toBe(1n);
    expect(result).toBeNull();
  });

  it("custom windowBlocks: startBlock = latestBlock - window", async () => {
    const { client, calls } = windowProbeClient(10_000n);

    const result = await findOpenEvent(
      client,
      POSITION_MANAGER,
      1n,
      WALLET,
      undefined,
      undefined,
      1_000n,
    );

    expect(calls[0].fromBlock).toBe(9_000n);
    expect(result).toBeNull();
  });

  it("custom window larger than latestBlock clamps startBlock to 1n", async () => {
    const { client, calls } = windowProbeClient(100n);

    const result = await findOpenEvent(
      client,
      POSITION_MANAGER,
      1n,
      WALLET,
      undefined,
      undefined,
      1_000_000n,
    );

    expect(calls[0].fromBlock).toBe(1n);
    expect(result).toBeNull();
  });

  it("window === latestBlock exactly clamps startBlock to 1n (boundary)", async () => {
    const { client, calls } = windowProbeClient(5_000n);

    const result = await findOpenEvent(
      client,
      POSITION_MANAGER,
      1n,
      WALLET,
      undefined,
      undefined,
      5_000n,
    );

    expect(calls[0].fromBlock).toBe(1n);
    expect(result).toBeNull();
  });

  it("explicit fromBlock wins over windowBlocks", async () => {
    const { client, calls } = windowProbeClient(10_000n);

    const result = await findOpenEvent(
      client,
      POSITION_MANAGER,
      1n,
      WALLET,
      undefined,
      9_500n,
      1_000n,
    );

    expect(calls[0].fromBlock).toBe(9_500n);
    expect(result).toBeNull();
  });

  it("returns null (does not throw) when no events found in window", async () => {
    const { client } = windowProbeClient(500n);

    const result = await findOpenEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(result).toBeNull();
  });
});

describe("findCloseEvent scan window computation", () => {
  it("explicit fromBlock wins over windowBlocks", async () => {
    const { client, calls } = windowProbeClient(10_000n);

    const result = await findCloseEvent(
      client,
      POSITION_MANAGER,
      1n,
      WALLET,
      undefined,
      9_500n,
      1_000n,
    );

    // findCloseEvent issues two getLogs (DecreaseLiquidity + Collect) per chunk.
    // Both calls in the first chunk must share the computed startBlock.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fromBlock).toBe(9_500n);
    const firstChunk = calls.filter((c) => c.toBlock === calls[0].toBlock);
    for (const c of firstChunk) {
      expect(c.fromBlock).toBe(9_500n);
    }
    expect(result).toBeNull();
  });

  it("default window clamps startBlock to 1n for a young chain", async () => {
    const { client, calls } = windowProbeClient(500n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(calls[0].fromBlock).toBe(1n);
    expect(result).toBeNull();
  });
});
