/**
 * EventResult discriminated union tests — isolated in a separate file to
 * avoid mock.module contamination from pnl-open-tx-persistence.test.ts.
 */

import { describe, expect, it } from "bun:test";

import { findCloseEvent, findOpenEvent } from "../chain/events.js";

type OpenClient = Parameters<typeof findOpenEvent>[0];

const TX_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;
const POSITION_MANAGER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as `0x${string}`;
const WALLET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;

describe("EventResult discriminated union", () => {
  const TOKEN_ID = 42n;

  // findOpenEvent

  it("findOpenEvent returns { status: 'found' } when IncreaseLiquidity log exists", async () => {
    const mockLog = {
      args: { tokenId: TOKEN_ID, liquidity: 100n, amount0: 1000n, amount1: 2000n },
      blockNumber: 500n,
      transactionHash: TX_HASH,
    };
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => [mockLog],
    } as unknown as OpenClient;

    const result = await findOpenEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(TOKEN_ID);
      expect(result.event.amount0).toBe(1000n);
      expect(result.event.amount1).toBe(2000n);
      expect(result.event.liquidity).toBe(100n);
      expect(result.event.blockNumber).toBe(500n);
      expect(result.event.transactionHash).toBe(TX_HASH);
    }
  });

  it("findOpenEvent returns { status: 'not_found' } when no logs found in all chunks", async () => {
    const client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => [],
    } as unknown as OpenClient;

    const result = await findOpenEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("not_found");
  });

  it("findOpenEvent returns { status: 'rpc_error' } when getLogs throws", async () => {
    const rpcErr = new Error("RPC unavailable");
    const client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => {
        throw rpcErr;
      },
    } as unknown as OpenClient;

    const result = await findOpenEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("rpc_error");
    if (result.status === "rpc_error") {
      expect(result.error).toBe(rpcErr);
    }
  });

  // findCloseEvent

  it("findCloseEvent returns { status: 'found' } when DecreaseLiquidity log exists", async () => {
    let callCount = 0;
    const mockDecreaseLog = {
      args: { tokenId: TOKEN_ID, liquidity: 50n, amount0: 3000n, amount1: 4000n },
      blockNumber: 600n,
      transactionHash: TX_HASH,
    };
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => {
        callCount += 1;
        return callCount === 1 ? [mockDecreaseLog] : [];
      },
    } as unknown as OpenClient;

    const result = await findCloseEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.event.tokenId).toBe(TOKEN_ID);
      expect(result.event.amount0).toBe(3000n);
      expect(result.event.amount1).toBe(4000n);
      expect(result.event.liquidity).toBe(50n);
    }
  });

  it("findCloseEvent returns { status: 'not_found' } when no logs found in all chunks", async () => {
    const client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => [],
    } as unknown as OpenClient;

    const result = await findCloseEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("not_found");
  });

  it("findCloseEvent returns { status: 'rpc_error' } when getLogs throws", async () => {
    const rpcErr = new Error("RPC connection refused");
    const client = {
      getBlockNumber: async () => 100n,
      getLogs: async () => {
        throw rpcErr;
      },
    } as unknown as OpenClient;

    const result = await findCloseEvent(client, POSITION_MANAGER, TOKEN_ID, WALLET);

    expect(result.status).toBe("rpc_error");
    if (result.status === "rpc_error") {
      expect(result.error).toBe(rpcErr);
    }
  });
});
