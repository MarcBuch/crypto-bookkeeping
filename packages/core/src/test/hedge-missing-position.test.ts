/**
 * Adversarial tests for getHedgeView() covering missing/closed position scenarios:
 *  - No hedge config
 *  - Token ID not in config
 *  - Empty assetPositions
 *  - Coin mismatch
 *  - szi = "0.00" (closed position)
 *  - assetPositions missing from response
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, mock, beforeEach } from "bun:test";

import type { Config } from "../config.js";
import { initSchema } from "../db/schema.js";
import { listHedgeEvents } from "../db/store.js";
import { getHedgeView } from "../services/hedge.js";
import { captureError, expectError } from "./helpers/errors.js";
import { getRequestType, jsonResponse, setFetchMock } from "./helpers/http.js";

// Mock getDb before importing store functions
let testDb: Database;

await mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

const originalFetch = globalThis.fetch;

function mockFetchJson(data: unknown, responseInit: ResponseInit = {}): void {
  setFetchMock(async (_input, requestInit) => {
    // For the secondary userFillsByTime call (triggered when position is absent),
    // return an empty array so hedge discovery finds no fills and falls through
    // to the throw — preserving the expected error behaviour.
    const responseData = getRequestType(requestInit) === "userFillsByTime" ? [] : data;
    return jsonResponse(responseData, responseInit);
  });
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/hedge/i);
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

    const error = await captureError(getHedgeView(config, "456"));
    expect(expectError(error).message).toMatch(/does not have a hedge configuration/i);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/hedge/i);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/HYPE/);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/no open/i);
  });

  it("does not write an aggregate closed hedge event when an absent config hedge has multiple historical closes", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          hedge: { coin: "HYPE" },
        },
      },
    });

    setFetchMock(async (_input, requestInit) => {
      const requestType = getRequestType(requestInit);
      if (requestType === "clearinghouseState") {
        return jsonResponse({ assetPositions: [] });
      }
      if (requestType === "userFillsByTime") {
        return jsonResponse([
          {
            coin: "HYPE",
            px: "100",
            sz: "1",
            side: "A",
            time: Date.parse("2024-01-01T00:00:00.000Z"),
            closedPnl: "0",
            oid: 1,
            tid: 1001,
            dir: "Open Short",
          },
          {
            coin: "HYPE",
            px: "90",
            sz: "1",
            side: "B",
            time: Date.parse("2024-01-02T00:00:00.000Z"),
            closedPnl: "10",
            oid: 2,
            tid: 2002,
            dir: "Close Short",
          },
          {
            coin: "HYPE",
            px: "110",
            sz: "1",
            side: "A",
            time: Date.parse("2024-01-03T00:00:00.000Z"),
            closedPnl: "0",
            oid: 3,
            tid: 3003,
            dir: "Open Short",
          },
          {
            coin: "HYPE",
            px: "120",
            sz: "1",
            side: "B",
            time: Date.parse("2024-01-04T00:00:00.000Z"),
            closedPnl: "-5",
            oid: 4,
            tid: 4004,
            dir: "Close Short",
          },
        ]);
      }
      throw new Error(`unexpected request type: ${requestType}`);
    });

    const error = await captureError(getHedgeView(config, "123"));

    expect(expectError(error).message).toMatch(/no open/i);
    expect(listHedgeEvents()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "closed",
        realized_pnl: 10,
        hl_fill_hash: "2002",
        token_id: null,
      }),
      expect.objectContaining({
        status: "closed",
        realized_pnl: -5,
        hl_fill_hash: "4004",
        token_id: null,
      }),
    ]));
    expect(listHedgeEvents()).toHaveLength(2);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/HYPE/);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/Available positions/);
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

    setFetchMock(async (_input, requestInit) => {
      if (getRequestType(requestInit) === "userFillsByTime") {
        return jsonResponse([]);
      }

      return jsonResponse({
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
      });
    });

    const result = await getHedgeView(config, "123");
    expect(result.status).toBe("closed");
    expect(result.unrealizedPnl).toBe(0);
    expect(result.szi).toBe("0.00");
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

    setFetchMock(async (_input, requestInit) => {
      if (getRequestType(requestInit) === "userFillsByTime") {
        return jsonResponse([]);
      }

      return jsonResponse({
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
      });
    });

    const result = await getHedgeView(config, "123");
    expect(result.status).toBe("closed");
    expect(result.unrealizedPnl).toBe(0);
    expect(result.szi).toBe("0");
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/assetPositions/);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/missing assetPositions/i);
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

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/Response structure/i);
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  it("throws when config.positions is undefined", async () => {
    const config = makeConfig({
      // No positions field
    });

    mockFetchJson({ assetPositions: [] });

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/hedge/i);
  });

  it("throws when config.positions is null", async () => {
    const config = makeConfig({
      // @ts-expect-error intentionally invalid runtime shape for guard coverage
      positions: null,
    });

    mockFetchJson({ assetPositions: [] });

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/hedge/i);
  });

  it("throws when hedge config is null", async () => {
    const config = makeConfig({
      positions: {
        "123": {
          openTx: "0xOPEN",
          // @ts-expect-error intentionally invalid runtime shape for guard coverage
          hedge: null,
        },
      },
    });

    mockFetchJson({ assetPositions: [] });

    const error = await captureError(getHedgeView(config, "123"));
    expect(expectError(error).message).toMatch(/hedge/i);
  });
});
