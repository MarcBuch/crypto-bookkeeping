import { describe, expect, it } from "bun:test";

import { encodeAbiParameters } from "viem";

import {
  findCloseEvent,
  findCloseEventFromTx,
  findOpenEvent,
  sumDecreaseLiquidityLogs,
} from "../chain/events.js";

type Hex = `0x${string}`;
type CloseClient = Parameters<typeof findCloseEventFromTx>[0];
type OpenClient = Parameters<typeof findOpenEvent>[0];
type Receipt = Awaited<ReturnType<CloseClient["getTransactionReceipt"]>>;
type GetLogs = OpenClient["getLogs"];
type SimpleEventLog = {
  args: Record<string, bigint>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex?: bigint;
};

const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
const RECIPIENT = "0x2222222222222222222222222222222222222222" as Hex;

const INCREASE_LIQUIDITY_TOPIC =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f" as Hex;
const DECREASE_LIQUIDITY_TOPIC =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4" as Hex;
const COLLECT_TOPIC = "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01" as Hex;

function tokenTopic(tokenId: bigint): Hex {
  return `0x${tokenId.toString(16).padStart(64, "0")}`;
}

function increaseLog(tokenId: bigint, amount0: bigint, amount1: bigint, liquidity = 999n) {
  return {
    topics: [INCREASE_LIQUIDITY_TOPIC, tokenTopic(tokenId)],
    data: encodeAbiParameters(
      [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
      [liquidity, amount0, amount1],
    ),
  };
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

function makeEventLog(
  args: Record<string, bigint>,
  blockNumber: bigint,
  transactionHash: Hex,
  logIndex?: bigint,
): SimpleEventLog {
  return {
    args,
    blockNumber,
    transactionHash,
    logIndex,
  };
}

function clientForLogs(
  logs: Array<ReturnType<typeof decreaseLog> | ReturnType<typeof collectLog>>,
) {
  const receipt: Receipt = {
    blockNumber: 458834n,
    transactionHash: TX_HASH,
    logs,
  };

  return {
    getTransactionReceipt: async () => receipt,
  };
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

describe("known transaction fast paths", () => {
  it("uses the open receipt path without falling back to log scans", async () => {
    let receiptCalls = 0;
    let getLogsCalls = 0;
    const client: OpenClient = {
      getBlockNumber: async () => 9_999n,
      getTransactionReceipt: async ({ hash }) => {
        receiptCalls += 1;
        expect(hash).toBe(TX_HASH);
        return {
          blockNumber: 123n,
          transactionHash: TX_HASH,
          logs: [increaseLog(123n, 100n, 200n, 50n)],
        };
      },
      getLogs: async () => {
        getLogsCalls += 1;
        return [];
      },
    };

    const result = await findOpenEvent(client, POSITION_MANAGER, 123n, WALLET, TX_HASH);

    expect(result).toEqual({
      status: "found",
      event: {
        tokenId: 123n,
        blockNumber: 123n,
        transactionHash: TX_HASH,
        amount0: 100n,
        amount1: 200n,
        liquidity: 50n,
      },
    });
    expect(receiptCalls).toBe(1);
    expect(getLogsCalls).toBe(0);
  });
});

function makeOpenClient(getLogs: GetLogs, latestBlock: bigint): OpenClient {
  return {
    getBlockNumber: async () => latestBlock,
    getLogs,
  };
}

/**
 * Mock client that exposes a controllable latestBlock and captures every
 * getLogs call's fromBlock/toBlock. getLogs always returns [] so the scan
 * completes (returns null) without finding an event.
 */
function windowProbeClient(latestBlock: bigint) {
  const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const getLogs = (async (args: { fromBlock?: bigint; toBlock?: bigint } | undefined) => {
    const fromBlock = typeof args?.fromBlock === "bigint" ? args.fromBlock : 0n;
    const toBlock = typeof args?.toBlock === "bigint" ? args.toBlock : 0n;
    calls.push({ fromBlock, toBlock });
    return [];
  }) as unknown as GetLogs;
  const client = makeOpenClient(getLogs, latestBlock);
  return { client, calls };
}

describe("findOpenEvent scan window computation", () => {
  it("default window: chain younger than window clamps startBlock to 1n", async () => {
    const { client, calls } = windowProbeClient(500n);

    const result = await findOpenEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fromBlock).toBe(1n);
    expect(result.status).toBe("not_found");
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
    expect(result.status).toBe("not_found");
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
    expect(result.status).toBe("not_found");
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
    expect(result.status).toBe("not_found");
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
    expect(result.status).toBe("not_found");
  });

  it("returns not_found (does not throw) when no events found in window", async () => {
    const { client } = windowProbeClient(500n);

    const result = await findOpenEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(result.status).toBe("not_found");
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

    // The close-event scan must use the explicit start block for each chunk.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].fromBlock).toBe(9_500n);
    const firstChunk = calls.filter((c) => c.toBlock === calls[0].toBlock);
    for (const c of firstChunk) {
      expect(c.fromBlock).toBe(9_500n);
    }
    expect(result.status).toBe("not_found");
  });

  it("default window clamps startBlock to 1n for a young chain", async () => {
    const { client, calls } = windowProbeClient(500n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET);

    expect(calls[0].fromBlock).toBe(1n);
    expect(result.status).toBe("not_found");
  });

  it("includes Collect logs before the close transaction as fees", async () => {
    let callCount = 0;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async (args: { fromBlock?: bigint; toBlock?: bigint } | undefined) => {
      callCount += 1;
      if (callCount === 1) {
        expect(args?.fromBlock).toBe(100n);
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 50n, amount0: 1_000n, amount1: 2_000n },
            300n,
            TX_HASH,
          ),
        ];
      }
      expect(args?.fromBlock).toBe(100n);
      expect(args?.toBlock).toBe(300n);
      if (callCount === 2) {
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 50n, amount0: 1_000n, amount1: 2_000n },
            300n,
            TX_HASH,
          ),
        ];
      }
      return [
        makeEventLog(
          { tokenId: 1n, amount0Collect: 10n, amount1Collect: 20n },
          200n,
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
        ),
        makeEventLog(
          { tokenId: 1n, amount0Collect: 1_005n, amount1Collect: 2_030n },
          300n,
          TX_HASH,
        ),
      ];
    }) as unknown as GetLogs;
    const client = makeOpenClient(getLogs, 1_000n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET, undefined, 100n);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.collectedFees0).toBe(15n);
      expect(result.event.collectedFees1).toBe(50n);
    }
  });

  it("subtracts all prior decreased principal when summing lifecycle Collect logs", async () => {
    let callCount = 0;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async (_args: { fromBlock?: bigint; toBlock?: bigint } | undefined) => {
      callCount += 1;
      if (callCount === 1) {
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 20n, amount0: 100n, amount1: 200n },
            300n,
            TX_HASH,
          ),
        ];
      }
      if (callCount === 2) {
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 10n, amount0: 40n, amount1: 80n },
            200n,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
          ),
          makeEventLog(
            { tokenId: 1n, liquidity: 20n, amount0: 100n, amount1: 200n },
            300n,
            TX_HASH,
          ),
        ];
      }
      return [
        makeEventLog(
          { tokenId: 1n, amount0Collect: 45n, amount1Collect: 90n },
          200n,
          "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
        ),
        makeEventLog({ tokenId: 1n, amount0Collect: 105n, amount1Collect: 215n }, 300n, TX_HASH),
      ];
    }) as unknown as GetLogs;
    const client = makeOpenClient(getLogs, 1_000n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET, undefined, 100n);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.collectedFees0).toBe(10n);
      expect(result.event.collectedFees1).toBe(25n);
    }
  });
});

describe("viem pagination semantics", () => {
  it("findCloseEvent scans all viem chunks and picks the latest close across the full range", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async (
      args:
        | {
            fromBlock?: bigint;
            toBlock?: bigint;
            event?: { name?: string };
          }
        | undefined,
    ) => {
      const fromBlock = args?.fromBlock ?? 0n;
      const toBlock = args?.toBlock ?? 0n;
      const eventName = args?.event?.name;

      if (eventName === "DecreaseLiquidity" && fromBlock === 1n && toBlock === 100_000n) {
        expect({ fromBlock, toBlock }).toEqual({ fromBlock: 1n, toBlock: 100_000n });
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 10n, amount0: 5n, amount1: 7n },
            50n,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
            1n,
          ),
        ];
      }

      if (eventName === "DecreaseLiquidity" && fromBlock === 100_001n && toBlock === 100_100n) {
        expect({ fromBlock, toBlock }).toEqual({ fromBlock: 100_001n, toBlock: 100_100n });
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 20n, amount0: 20n, amount1: 30n },
            100_050n,
            TX_HASH,
            2n,
          ),
        ];
      }

      if (eventName === "DecreaseLiquidity" && fromBlock === 100_001n && toBlock === 100_050n) {
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 20n, amount0: 20n, amount1: 30n },
            100_050n,
            TX_HASH,
            2n,
          ),
        ];
      }

      if (eventName === "Collect" && fromBlock === 1n && toBlock === 100_000n) {
        return [
          makeEventLog(
            { tokenId: 1n, amount0Collect: 6n, amount1Collect: 9n },
            50n,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex,
            3n,
          ),
        ];
      }

      if (eventName === "Collect" && fromBlock === 100_001n && toBlock === 100_050n) {
        return [
          makeEventLog(
            { tokenId: 1n, amount0Collect: 27n, amount1Collect: 41n },
            100_050n,
            TX_HASH,
            4n,
          ),
        ];
      }

      throw new Error(
        `Unexpected getLogs call for ${String(eventName)} ${fromBlock.toString()}-${toBlock.toString()}`,
      );
    }) as unknown as OpenClient["getLogs"];
    const client = makeOpenClient(getLogs, 100_100n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET, undefined, 1n);

    expect(result).toEqual({
      status: "found",
      event: {
        tokenId: 1n,
        blockNumber: 100_050n,
        transactionHash: TX_HASH,
        amount0: 20n,
        amount1: 30n,
        liquidity: 20n,
        collectedFees0: 8n,
        collectedFees1: 13n,
      },
    });
  });

  it("findCloseEvent prefers the larger same-block logIndex when both viem close logs are indexed", async () => {
    let callCount = 0;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return [
          makeEventLog(
            { tokenId: 1n, liquidity: 10n, amount0: 10n, amount1: 20n },
            500n,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
            1n,
          ),
          makeEventLog(
            { tokenId: 1n, liquidity: 11n, amount0: 11n, amount1: 21n },
            500n,
            TX_HASH,
            2n,
          ),
        ];
      }
      return [];
    }) as unknown as OpenClient["getLogs"];
    const client = makeOpenClient(getLogs, 500n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET, undefined, 1n);

    expect(result).toEqual({
      status: "found",
      event: {
        tokenId: 1n,
        blockNumber: 500n,
        transactionHash: TX_HASH,
        amount0: 11n,
        amount1: 21n,
        liquidity: 11n,
        collectedFees0: 0n,
        collectedFees1: 0n,
      },
    });
  });

  it("findCloseEvent deterministically prefers indexed same-block viem logs over unindexed ones", async () => {
    let callCount = 0;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async () => {
      callCount += 1;
      if (callCount === 1) {
        return [
          // Safe tie-break: when one same-block log has no logIndex, keep the indexed log
          // because its ordering is explicit while the unindexed log's position is ambiguous.
          makeEventLog(
            { tokenId: 1n, liquidity: 10n, amount0: 10n, amount1: 20n },
            500n,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
          ),
          makeEventLog(
            { tokenId: 1n, liquidity: 12n, amount0: 12n, amount1: 22n },
            500n,
            TX_HASH,
            1n,
          ),
        ];
      }
      return [];
    }) as unknown as OpenClient["getLogs"];
    const client = makeOpenClient(getLogs, 500n);

    const result = await findCloseEvent(client, POSITION_MANAGER, 1n, WALLET, undefined, 1n);

    expect(result).toEqual({
      status: "found",
      event: {
        tokenId: 1n,
        blockNumber: 500n,
        transactionHash: TX_HASH,
        amount0: 12n,
        amount1: 22n,
        liquidity: 12n,
        collectedFees0: 0n,
        collectedFees1: 0n,
      },
    });
  });

  it("chunks DecreaseLiquidity aggregation into the existing 100k block windows", async () => {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const getLogs = (async (args: { fromBlock?: bigint; toBlock?: bigint } | undefined) => {
      const fromBlock = args?.fromBlock ?? 0n;
      const toBlock = args?.toBlock ?? 0n;
      calls.push({ fromBlock, toBlock });

      if (fromBlock === 5n) {
        return [
          makeEventLog({ tokenId: 1n, liquidity: 1n, amount0: 10n, amount1: 20n }, 6n, TX_HASH),
        ];
      }
      if (fromBlock === 200_005n) {
        return [
          makeEventLog({ tokenId: 1n, liquidity: 1n, amount0: 3n, amount1: 4n }, 200_006n, TX_HASH),
        ];
      }
      return [];
    }) as unknown as OpenClient["getLogs"];
    const client = { getLogs };

    const totals = await sumDecreaseLiquidityLogs(client, POSITION_MANAGER, 1n, 5n, 200_010n);

    expect(totals).toEqual({ amount0: 13n, amount1: 24n });
    expect(calls).toEqual([
      { fromBlock: 5n, toBlock: 100_004n },
      { fromBlock: 100_005n, toBlock: 200_004n },
      { fromBlock: 200_005n, toBlock: 200_010n },
    ]);
  });
});
