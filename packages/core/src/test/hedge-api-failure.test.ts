/**
 * Adversarial tests for getHedgeView() API failure scenarios:
 *  - Network errors (fetch throws)
 *  - Non-200 responses (fetch resolves with ok: false)
 *  - Invalid JSON responses
 *  - Empty or malformed response objects
 *  - Missing required fields in positions
 *  - Null assetPositions
 */

import { Database } from "bun:sqlite";
import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

import { initSchema } from "../db/schema.js";
import { captureError, expectError } from "./helpers/errors.js";
import { getRequestType, jsonResponse, setFetchMock, textResponse } from "./helpers/http.js";

// Mock getDb before importing store functions
let testDb: Database;

await mock.module("../db/schema.js", () => ({
  getDb: () => testDb,
  initSchema,
  resolveDbPath: () => ":memory:",
  resetDb: () => {},
}));

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

let mockFetch: (input: FetchInput, init: FetchInit) => Response | Promise<Response> = async () =>
  jsonResponse({});

// Mock globalThis.fetch before importing the module under test
const originalFetch = globalThis.fetch;
setFetchMock((input, init) => mockFetch(input, init));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import type { Config } from "../config.js";
import { getHedgeView } from "../services/hedge.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const baseConfig: Config = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
  positions: {
    "484645": {
      openTx: "0xOPEN",
      hedge: {
        coin: "HYPE",
      },
    },
  },
};

const validHyperliquidResponse = {
  assetPositions: [
    {
      position: {
        coin: "HYPE",
        szi: "-30.1",
        entryPx: "1.5",
        positionValue: "45.15",
        unrealizedPnl: "2.5",
        cumFunding: {
          sinceOpen: "0.5",
        },
        leverage: { type: "cross", value: 1 },
        liquidationPx: "0.5",
        markPx: "1.6",
      },
      type: "perp",
    },
  ],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Create a fresh in-memory database for each test
  testDb = new Database(":memory:");
  initSchema(testDb);

  mockFetch = async () => jsonResponse(validHyperliquidResponse);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Cluster: API failure scenarios
// ---------------------------------------------------------------------------

describe("getHedgeView() — API failure scenarios", () => {
  // Test 1: Network error
  it("network error: fetch throws Error → getHedgeView rejects with error", async () => {
    mockFetch = async () => {
      throw new Error("network error");
    };

    const error = await captureError(getHedgeView(baseConfig, "484645"));
    expect(expectError(error).message).toContain("network error");
  });

  // Test 2: Non-200 response
  it("non-200 response: fetch resolves with ok: false, status 503 → throws with status code", async () => {
    mockFetch = async () => jsonResponse({}, { status: 503, statusText: "Service Unavailable" });

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("503");
  });

  // Test 3: Response not valid JSON
  it("response not valid JSON: fetch resolves with ok: true but .json() throws → propagates rejection", async () => {
    mockFetch = async () => textResponse("<not-json>", { status: 200 });

    const error = await captureError(getHedgeView(baseConfig, "484645"));
    expect(expectError(error)).toBeInstanceOf(Error);
  });

  // Test 4: Response is empty object {}
  it("response is empty object {}: HL returns {} → throws structured error", async () => {
    mockFetch = async () => jsonResponse({});

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("assetPositions");
  });

  // Test 5: Response has assetPositions with malformed entryPx
  it("response has assetPositions with empty entryPx: position.entryPx parses as NaN", async () => {
    mockFetch = async () =>
      jsonResponse({
        assetPositions: [
          {
            position: {
              coin: "HYPE",
              szi: "-30.1",
              entryPx: "",
              positionValue: "45.15",
              unrealizedPnl: "2.5",
              cumFunding: {
                sinceOpen: "0.5",
              },
              leverage: { type: "cross", value: 1 },
              liquidationPx: "0.5",
              markPx: "1.6",
            },
            type: "perp",
          },
        ],
      });

    const result = await getHedgeView(baseConfig, "484645");

    // entryPx should be NaN when missing
    expect(Number.isNaN(result.entryPx)).toBe(true);
    // markPx should still parse correctly
    expect(result.markPx).toBe(1.6);
  });

  // Test 6: Response has assetPositions: null
  it("response has assetPositions: null → throws structured error, not TypeError", async () => {
    mockFetch = async () =>
      jsonResponse({
        assetPositions: null,
      });

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("assetPositions");
  });

  // Additional edge case: 404 response
  it("404 response: fetch resolves with ok: false, status 404 → throws with status code", async () => {
    mockFetch = async () => jsonResponse({}, { status: 404, statusText: "Not Found" });

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("404");
  });

  // Additional edge case: 500 response
  it("500 response: fetch resolves with ok: false, status 500 → throws with status code", async () => {
    mockFetch = async () => jsonResponse({}, { status: 500, statusText: "Internal Server Error" });

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("500");
  });

  // Additional edge case: assetPositions is empty array
  it("assetPositions is empty array: no matching HYPE position → throws error", async () => {
    mockFetch = async (_input, init) => {
      if (getRequestType(init) === "userFillsByTime") {
        // No fills found — resolveAbsentPosition returns null → falls through to throw
        return jsonResponse([]);
      }
      return jsonResponse({
        assetPositions: [],
      });
    };

    const promise = getHedgeView(baseConfig, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("No open");
  });

  // Additional edge case: position with szi = 0 (closed)
  it("position with szi = 0 (closed): returns closed HedgeView", async () => {
    let callCount = 0;
    mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        // First call: clearinghouseState with szi=0
        return jsonResponse({
          assetPositions: [
            {
              position: {
                coin: "HYPE",
                szi: "0", // Closed position
                entryPx: "1.5",
                positionValue: "0",
                unrealizedPnl: "0",
                cumFunding: {
                  sinceOpen: "0",
                },
                leverage: { type: "cross", value: 1 },
                liquidationPx: "0",
                markPx: "1.6",
              },
              type: "perp",
            },
          ],
        });
      } else {
        // Second call: userFillsByTime with empty fills
        return jsonResponse([]);
      }
    };

    const result = await getHedgeView(baseConfig, "484645");
    expect(result.status).toBe("closed");
    expect(result.unrealizedPnl).toBe(0);
    expect(result.szi).toBe("0");
  });

  // Additional edge case: missing hedge config
  it("missing hedge config: position #484645 has no hedge config → throws error", async () => {
    const configWithoutHedge: Config = {
      ...baseConfig,
      positions: {
        "484645": {
          openTx: "0xOPEN",
          // hedge deliberately missing
        },
      },
    };

    const promise = getHedgeView(configWithoutHedge, "484645");
    const error = await captureError(promise);
    expect(expectError(error).message).toContain("hedge");
  });

  // Additional edge case: valid response with all fields
  it("valid response: all fields present and valid → returns HedgeView", async () => {
    mockFetch = async () => jsonResponse(validHyperliquidResponse);

    const result = await getHedgeView(baseConfig, "484645");

    expect(result.tokenId).toBe("484645");
    expect(result.coin).toBe("HYPE");
    expect(result.szi).toBe("-30.1");
    expect(result.entryPx).toBe(1.5);
    expect(result.markPx).toBe(1.6);
    expect(result.unrealizedPnl).toBe(2.5);
    expect(result.fundingEarned).toBe(0.5);
    expect(result.liquidationPx).toBe(0.5);
    expect(result.leverage).toEqual({ type: "cross", value: 1 });
  });

  // Additional edge case: liquidationPx is NaN (converted to null)
  it("liquidationPx is NaN: converts to null in HedgeView", async () => {
    mockFetch = async () =>
      jsonResponse({
        assetPositions: [
          {
            position: {
              coin: "HYPE",
              szi: "-30.1",
              entryPx: "1.5",
              positionValue: "45.15",
              unrealizedPnl: "2.5",
              cumFunding: {
                sinceOpen: "0.5",
              },
              leverage: { type: "cross", value: 1 },
              liquidationPx: "invalid", // Will parse to NaN
              markPx: "1.6",
            },
            type: "perp",
          },
        ],
      });

    const result = await getHedgeView(baseConfig, "484645");

    expect(result.liquidationPx).toBeNull();
  });

  // Additional edge case: cumFunding.sinceOpen missing (defaults to "0")
  it("cumFunding.sinceOpen missing: defaults to 0", async () => {
    mockFetch = async () =>
      jsonResponse({
        assetPositions: [
          {
            position: {
              coin: "HYPE",
              szi: "-30.1",
              entryPx: "1.5",
              positionValue: "45.15",
              unrealizedPnl: "2.5",
              cumFunding: {
                // sinceOpen deliberately missing
              },
              leverage: { type: "cross", value: 1 },
              liquidationPx: "0.5",
              markPx: "1.6",
            },
            type: "perp",
          },
        ],
      });

    const result = await getHedgeView(baseConfig, "484645");

    expect(result.fundingEarned).toBe(0);
  });
});
