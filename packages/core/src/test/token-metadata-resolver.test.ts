import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";

import { resetDb } from "../db/schema.js";
import { getTokenMetadata, upsertTokenMetadata } from "../db/store.js";
import { resolveTokenMetadata } from "../chain/token-metadata.js";
import type { Client } from "../chain/client.js";

const TMP =
  "/var/folders/bv/cfnpmk5j1l105w6mjddhgbfw0000gp/T/opencode/lp-tracker-token-metadata-resolver-tests";

// A valid checksummed ERC-55 address and its lowercase counterpart.
const ADDR_LOWER = "0xabcdef1234567890abcdef1234567890abcdef12";
const ADDR_CHECKSUM = "0xAbCdEf1234567890AbCdEf1234567890AbCdEf12";

function mockClient(overrides: {
  readContract?: (args: { functionName: string }) => Promise<unknown>;
}): Client {
  return {
    readContract: overrides.readContract ?? (() => Promise.reject(new Error("not implemented"))),
  } as unknown as Client;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  process.env.LP_TRACKER_DATA_DIR = TMP;
});

afterEach(() => {
  resetDb();
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Suite 1: DB cache hit
// ---------------------------------------------------------------------------
describe("resolveTokenMetadata — DB cache hit", () => {
  it("cache hit returns immediately without calling readContract", async () => {
    upsertTokenMetadata({
      contract_address: ADDR_LOWER,
      symbol: "TKN",
      name: "Token",
      decimals: 18,
      fetched_at: new Date().toISOString(),
    });

    // If readContract is called the mock will throw — test would fail.
    const client = mockClient({
      readContract: () => {
        throw new Error("readContract must NOT be called on a cache hit");
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.symbol).toBe("TKN");
    expect(result.name).toBe("Token");
    expect(result.decimals).toBe(18);
  });

  it("cache hit is case-insensitive (checksummed address finds lowercase-stored row)", async () => {
    upsertTokenMetadata({
      contract_address: ADDR_LOWER,
      symbol: "TKN",
      name: "Token",
      decimals: 6,
      fetched_at: new Date().toISOString(),
    });

    const client = mockClient({
      readContract: () => {
        throw new Error("readContract must NOT be called on a cache hit");
      },
    });

    // Pass the checksummed address — should still be a cache hit.
    const result = await resolveTokenMetadata(client, ADDR_CHECKSUM);
    expect(result.symbol).toBe("TKN");
    expect(result.decimals).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Successful RPC fetch
// ---------------------------------------------------------------------------
describe("resolveTokenMetadata — successful RPC fetch", () => {
  it("full ERC-20: all three calls succeed → symbol, name, decimals populated", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "USDC";
        if (functionName === "name") return "USD Coin";
        if (functionName === "decimals") return 6;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.symbol).toBe("USDC");
    expect(result.name).toBe("USD Coin");
    expect(result.decimals).toBe(6);
  });

  it("result is stored in DB after successful fetch", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "WETH";
        if (functionName === "name") return "Wrapped Ether";
        if (functionName === "decimals") return 18;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    await resolveTokenMetadata(client, ADDR_LOWER);

    const stored = getTokenMetadata(ADDR_LOWER);
    expect(stored).not.toBeNull();
    expect(stored!.symbol).toBe("WETH");
    expect(stored!.name).toBe("Wrapped Ether");
    expect(stored!.decimals).toBe(18);
  });

  it("decimals=0 is stored as 0, not null", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "NFT";
        if (functionName === "name") return "Non-Fungible Token";
        if (functionName === "decimals") return 0;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.decimals).toBe(0);

    const stored = getTokenMetadata(ADDR_LOWER);
    expect(stored!.decimals).toBe(0);
  });

  it("address stored as lowercase even if contractAddress is checksummed", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "TKN";
        if (functionName === "name") return "Token";
        if (functionName === "decimals") return 18;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_CHECKSUM);
    expect(result.contract_address).toBe(ADDR_LOWER);

    // DB lookup by lowercase should find it.
    const stored = getTokenMetadata(ADDR_LOWER);
    expect(stored).not.toBeNull();
    expect(stored!.contract_address).toBe(ADDR_LOWER);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Partial / failed RPC calls
// ---------------------------------------------------------------------------
describe("resolveTokenMetadata — partial/failed RPC calls", () => {
  it("symbol() reverts → symbol=null, name and decimals still fetched", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") throw new Error("execution reverted");
        if (functionName === "name") return "Token";
        if (functionName === "decimals") return 18;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.symbol).toBeNull();
    expect(result.name).toBe("Token");
    expect(result.decimals).toBe(18);
  });

  it("all three fail (EOA/non-ERC20) → all-null metadata stored and returned", async () => {
    const client = mockClient({
      readContract: async () => {
        throw new Error("execution reverted: not a contract");
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.symbol).toBeNull();
    expect(result.name).toBeNull();
    expect(result.decimals).toBeNull();
    expect(result.contract_address).toBe(ADDR_LOWER);
  });

  it("all-null result is cached: second call returns from DB, readContract not called again", async () => {
    let callCount = 0;
    const client = mockClient({
      readContract: async () => {
        callCount++;
        throw new Error("execution reverted");
      },
    });

    // First call — goes to RPC, stores all-null.
    await resolveTokenMetadata(client, ADDR_LOWER);
    const firstCallCount = callCount;

    // Second call — should hit DB cache, readContract not called again.
    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(callCount).toBe(firstCallCount); // no additional calls
    expect(result.symbol).toBeNull();
    expect(result.name).toBeNull();
    expect(result.decimals).toBeNull();
  });

  it("decimals() returns 0 → decimals=0 (not null)", async () => {
    const client = mockClient({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "TKN";
        if (functionName === "name") return "Token";
        if (functionName === "decimals") return 0;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    const result = await resolveTokenMetadata(client, ADDR_LOWER);
    expect(result.decimals).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Invalid address
// ---------------------------------------------------------------------------
describe("resolveTokenMetadata — invalid address", () => {
  it("non-hex string throws with message containing 'invalid contract address'", async () => {
    const client = mockClient({});

    await expect(resolveTokenMetadata(client, "not-an-address")).rejects.toThrow(
      "invalid contract address",
    );
  });

  it("empty string throws with message containing 'invalid contract address'", async () => {
    const client = mockClient({});

    await expect(resolveTokenMetadata(client, "")).rejects.toThrow("invalid contract address");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Concurrent deduplication
// ---------------------------------------------------------------------------
describe("resolveTokenMetadata — concurrent deduplication", () => {
  it("two concurrent calls for same address → readContract called exactly once", async () => {
    let callCount = 0;

    const client = mockClient({
      readContract: async ({ functionName }) => {
        callCount++;
        // Simulate a small async delay to make concurrency realistic.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (functionName === "symbol") return "TKN";
        if (functionName === "name") return "Token";
        if (functionName === "decimals") return 18;
        throw new Error(`unexpected functionName: ${functionName}`);
      },
    });

    // Start both without awaiting — they should share the same in-flight promise.
    const [r1, r2] = await Promise.all([
      resolveTokenMetadata(client, ADDR_LOWER),
      resolveTokenMetadata(client, ADDR_LOWER),
    ]);

    // Each of symbol/name/decimals should be called exactly once (3 total, not 6).
    expect(callCount).toBe(3);
    expect(r1.symbol).toBe("TKN");
    expect(r2.symbol).toBe("TKN");
  });
});
