import { describe, expect, it } from "bun:test";

import { encodeAbiParameters, type TransactionReceipt } from "viem";

import { findCloseEventFromTx } from "../chain/events.js";

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
