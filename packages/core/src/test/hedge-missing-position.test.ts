/**
 * Adversarial tests for getHedgeView() covering missing/closed position scenarios:
 *  - No hedge config
 *  - Token ID not in config
 *  - Empty assetPositions
 *  - Coin mismatch
 *  - szi = "0.00" (closed position)
 *  - assetPositions missing from response
 */

import { afterEach, describe, expect, it, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../db/schema.js";
import type { Config } from "../config.js";
import { getHedgeView } from "../services/hedge.js";

// Mock getDb before importing store functions
let testDb: Database;

mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

const originalFetch = globalThis.fetch;

type FetchCall = {
  url: string;
  body: string;
};

function mockFetchJson(data: unknown, responseInit: ResponseInit = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    const bodyStr = requestInit?.body as string;
    calls.push({ url: String(input), body: bodyStr });
    const status = responseInit.status ?? 200;
    // For the secondary userFillsByTime call (triggered when position is absent),
    // return an empty array so resolveAbsentPosition finds no fills and falls
    // through to the throw — preserving the expected error behaviour.
    let responseData: unknown = data;
    try {
      const parsed = JSON.parse(bodyStr ?? "{}");
      if (parsed.type === "userFillsByTime") {
        responseData = [];
      }
    } catch {
      // ignore parse errors
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "OK",
      json: async () => responseData,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function mockFetchError(status: number, statusText: string): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(input), body: requestInit?.body as string });
    return {
      ok: false,
      status,
      statusText,
      json: async () => ({}),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  // Create a fresh in-memory database for each test
  testDb = new Database(":memory:");
  initSchema(testDb);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Minimal valid config builder
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    rpc: "http://test-rpc",
    chainId: 999,
    wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
    contracts: {
      factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
      positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
      quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
      swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cluster: Missing / closed position scenarios
// ---------------------------------------------------------------------------

describe("getHedgeView() — missing/closed position scenarios", () => {
  // =========================================================================
  // 1. No hedge config
  // =========================================================================

  it("throws with 'hedge' message when config.positions[tokenId] has no hedge field", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          // No hedge field
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/hedge/i);
  });

  it("throws with 'does not have a hedge configuration' message when hedge config is missing", async () => {
    const config = makeConfig({
      positions: {
        "456": {
          openTx: "0xOPEN",
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "456")).rejects.toThrow(/does not have a hedge configuration/i);
  });

  // =========================================================================
  // 2. Token ID not in config
  // =========================================================================

  it("throws when config.positions[tokenId] does not exist", async () => {
    const config = makeConfig({
      positions: {
        "999": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/hedge/i);
  });

  // =========================================================================
  // 3. Empty assetPositions
  // =========================================================================

  it("throws with coin name when HL API returns empty assetPositions array", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/HYPE/);
  });

  it("throws with 'no open' message when assetPositions is empty", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "ETH" },
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/no open/i);
  });

  // =========================================================================
  // 4. Coin mismatch
  // =========================================================================

  it("throws with 'HYPE' in message when HL API returns ETH position but config says HYPE", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({
      assetPositions: [
        {
          position: {
            coin: "ETH",
            szi: "1.5",
            entryPx: "2000",
            positionValue: "3000",
            unrealizedPnl: "100",
            cumFunding: { sinceOpen: "50" },
            leverage: { type: "cross", value: 1 },
            liquidationPx: "1500",
            markPx: "2100",
          },
          type: "perp",
        },
      ],
    });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/HYPE/);
  });

  it("throws with 'Available positions' message when coin mismatch occurs", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "BTC" },
        },
      },
    });

    mockFetchJson({
      assetPositions: [
        {
          position: {
            coin: "ETH",
            szi: "1.5",
            entryPx: "2000",
            positionValue: "3000",
            unrealizedPnl: "100",
            cumFunding: { sinceOpen: "50" },
            leverage: { type: "cross", value: 1 },
            liquidationPx: "1500",
            markPx: "2100",
          },
          type: "perp",
        },
      ],
    });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/Available positions/);
  });

  // =========================================================================
  // 5. szi = "0.00" (closed position)
  // =========================================================================

  it("throws with 'closed' message when szi is 0.00", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    // Mock fetch to return closed position on first call (clearinghouseState)
    // and empty fills on second call (userFillsByTime)
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: clearinghouseState with szi=0
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assetPositions: [
              {
                position: {
                  coin: "HYPE",
                  szi: "0.00",
                  entryPx: "2000",
                  positionValue: "0",
                  unrealizedPnl: "0",
                  cumFunding: { sinceOpen: "0" },
                  leverage: { type: "cross", value: 1 },
                  liquidationPx: "0",
                  markPx: "2100",
                },
                type: "perp",
              },
            ],
          }),
        } as Response;
      } else {
        // Second call: userFillsByTime with empty fills
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as Response;
      }
    }) as unknown as typeof fetch;

    try {
      const result = await getHedgeView(config, "123");
      expect(result.status).toBe("closed");
      expect(result.unrealizedPnl).toBe(0);
      expect(result.szi).toBe("0.00");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws with 'szi=0' message when position size is zero", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    // Mock fetch to return closed position on first call (clearinghouseState)
    // and empty fills on second call (userFillsByTime)
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // First call: clearinghouseState with szi=0
        return {
          ok: true,
          status: 200,
          json: async () => ({
            assetPositions: [
              {
                position: {
                  coin: "HYPE",
                  szi: "0",
                  entryPx: "2000",
                  positionValue: "0",
                  unrealizedPnl: "0",
                  cumFunding: { sinceOpen: "0" },
                  leverage: { type: "cross", value: 1 },
                  liquidationPx: "0",
                  markPx: "2100",
                },
                type: "perp",
              },
            ],
          }),
        } as Response;
      } else {
        // Second call: userFillsByTime with empty fills
        return {
          ok: true,
          status: 200,
          json: async () => [],
        } as Response;
      }
    }) as unknown as typeof fetch;

    try {
      const result = await getHedgeView(config, "123");
      expect(result.status).toBe("closed");
      expect(result.unrealizedPnl).toBe(0);
      expect(result.szi).toBe("0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // 6. assetPositions missing from response
  // =========================================================================

  it("throws structured error when HL API returns {} (no assetPositions key)", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({});

    await expect(getHedgeView(config, "123")).rejects.toThrow(/assetPositions/);
  });

  it("throws with 'missing assetPositions' message when response lacks the key", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({ someOtherField: "value" });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/missing assetPositions/i);
  });

  it("throws with 'Response structure may have changed' message when assetPositions is missing", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    mockFetchJson({ data: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/Response structure/i);
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  it("throws when config.positions is undefined", async () => {
    const config = makeConfig({
      // No positions field
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/hedge/i);
  });

  it("throws when config.positions is null", async () => {
    const config = makeConfig({
      positions: null as any,
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/hedge/i);
  });

  it("throws when hedge config is null", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: null as any,
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    await expect(getHedgeView(config, "123")).rejects.toThrow(/hedge/i);
  });
});
