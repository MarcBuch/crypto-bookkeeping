/**
 * Adversarial tests for hedge sync wiring:
 *  Cluster: Sync wiring isolation
 *
 *  1. snapshotHedge throws → LP sync result unaffected
 *     - Mock getHedgeView to throw, mock LP sync internals to succeed
 *     - Verify syncSinglePosition resolves (does not throw)
 *
 *  2. No hedge config → hedge code not called
 *     - Config has a position without hedge field
 *     - Verify getHedgeView is never called (use a spy)
 *
 *  3. Hedge config present + getHedgeView succeeds → snapshotHedge is called
 *     - Verify the happy path: when hedge config is present and API succeeds,
 *       snapshotHedge is called once
 */

import { mock, describe, it, expect, beforeEach, afterEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks must be set up BEFORE importing the module under test
// ---------------------------------------------------------------------------

let mockGetPositionData: (...args: unknown[]) => unknown = async () => ({});
let mockGetPnLView: (...args: unknown[]) => unknown = async () => [];
let mockGetHedgeView: (...args: unknown[]) => unknown = async () => ({});
let mockSnapshotHedge: (...args: unknown[]) => unknown = () => {};

await mock.module("../chain/positions.js", () => ({
  getAllPositions: async () => [],
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: (...args: unknown[]) => mockGetPositionData(...args),
}));

await mock.module("../chain/pools.js", () => ({
  getTokenInfo: async () => ({ symbol: "TEST", decimals: 18 }),
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099",
  getSlot0: async () => ({
    address: "0x0000000000000000000000000000000000000099",
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
  }),
  getPoolState: async () => ({
    sqrtPriceX96: 79228162514264337593543950336n,
    tick: 0,
    feeGrowthGlobal0X128: 0n,
    feeGrowthGlobal1X128: 0n,
  }),
  getTickData: async () => ({
    feeGrowthOutside0X128: 0n,
    feeGrowthOutside1X128: 0n,
  }),
}));

await mock.module("../chain/client.js", () => ({
  createClient: () => ({}),
}));

await mock.module("../chain/events.js", () => ({
  findOpenEvent: async () => ({
    blockNumber: 100000n,
    amount0: 1000000000000000000n,
    amount1: 1000000000n,
    liquidity: 1000000000000000000n,
  }),
  findCloseEvent: async () => null,
  getPoolPriceAtBlock: async () => ({ sqrtPriceX96: 79228162514264337593543950336n }),
}));

await mock.module("../services/pnl.js", () => ({
  getPnLView: (...args: unknown[]) => mockGetPnLView(...args),
  calculateUsdFeeIncome: () => ({
    feesCollected0Usd: null,
    feesCollected1Usd: null,
    feesValueUsd: null,
    usdPriceSource: null,
  }),
}));

await mock.module("../services/hedge.js", () => ({
  getHedgeView: (...args: unknown[]) => mockGetHedgeView(...args),
  snapshotHedge: (...args: unknown[]) => mockSnapshotHedge(...args),
}));

// ---------------------------------------------------------------------------
// Now import the module under test + DB helpers
// ---------------------------------------------------------------------------

import { syncSinglePosition, syncLpData } from "../services/positions.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const fakeConfig = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
};

const fakeRawPosition = {
  tokenId: 12345n,
  liquidity: 1000000000000000000n,
  tickLower: -100,
  tickUpper: 100,
  token0: "0x0000000000000000000000000000000000000aaa",
  token1: "0x0000000000000000000000000000000000000bbb",
  fee: 3000,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
};

const fakeHedgeView = {
  tokenId: "12345",
  coin: "HYPE",
  szi: "-30.1",
  entryPx: 1.5,
  markPx: 1.6,
  unrealizedPnl: 3.0,
  fundingEarned: 0.5,
  liquidationPx: 0.5,
  leverage: { type: "cross", value: 1 },
};

// ---------------------------------------------------------------------------
// Test setup/teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  // Reset mocks to safe defaults
  mockGetPositionData = async () => fakeRawPosition;
  mockGetPnLView = async () => [];
  mockGetHedgeView = async () => fakeHedgeView;
  mockSnapshotHedge = () => {};
});

afterEach(() => {
  // afterEach is handled by useTestDb()
});

// ---------------------------------------------------------------------------
// Test 1: getHedgeView throws → LP sync result unaffected
// ---------------------------------------------------------------------------

describe("hedge sync wiring — getHedgeView throws", () => {
  it("syncSinglePosition resolves even when getHedgeView throws (error swallowed)", async () => {
    // Config WITH hedge
    const configWithHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          hedge: { coin: "HYPE" },
        },
      },
    };

    // Mock getHedgeView to throw
    mockGetHedgeView = async () => {
      throw new Error("Hyperliquid API timeout");
    };

    // Should NOT throw — error is swallowed
    const result = await syncSinglePosition(configWithHedge, "12345");

    // Verify result is valid
    expect(result).toBeDefined();
    expect(result.tokenId).toBe("12345");
    expect(typeof result.syncedAt).toBe("string");
  });

  it("syncLpData resolves even when getHedgeView throws for one position", async () => {
    // Config with hedge for position 12345
    const configWithHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          hedge: { coin: "HYPE" },
        },
      },
    };

    // Mock getAllPositions to return one position
    mockGetPositionData = async () => fakeRawPosition;

    let getAllPositionsCallCount = 0;
    await mock.module("../chain/positions.js", () => ({
      getAllPositions: async () => {
        getAllPositionsCallCount++;
        return [fakeRawPosition];
      },
      getPositionCount: async () => 0n,
      getTokenId: async () => 0n,
      getPositionData: (...args: unknown[]) => mockGetPositionData(...args),
    }));

    // Mock getHedgeView to throw
    mockGetHedgeView = async () => {
      throw new Error("Hyperliquid API down");
    };

    // Should NOT throw — error is swallowed
    const result = await syncLpData(configWithHedge);

    // Verify result is valid
    expect(result).toBeDefined();
    expect(result.wallet).toBe(configWithHedge.wallet);
    expect(result.positionCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: No hedge config → hedge code not called
// ---------------------------------------------------------------------------

describe("hedge sync wiring — no hedge config", () => {
  it("syncSinglePosition does not call getHedgeView when position has no hedge config", async () => {
    // Config WITHOUT hedge for position 12345
    const configWithoutHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          // NO hedge field
        },
      },
    };

    // Track if getHedgeView was called
    let getHedgeViewCalled = false;
    mockGetHedgeView = async () => {
      getHedgeViewCalled = true;
      return fakeHedgeView;
    };

    // Call syncSinglePosition
    const result = await syncSinglePosition(configWithoutHedge, "12345");

    // Verify result is valid
    expect(result).toBeDefined();
    expect(result.tokenId).toBe("12345");

    // Verify getHedgeView was NOT called
    expect(getHedgeViewCalled).toBe(false);
  });

  it("syncSinglePosition does not call snapshotHedge when position has no hedge config", async () => {
    // Config WITHOUT hedge
    const configWithoutHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          // NO hedge field
        },
      },
    };

    // Track if snapshotHedge was called
    let snapshotHedgeCalled = false;
    mockSnapshotHedge = () => {
      snapshotHedgeCalled = true;
    };

    // Call syncSinglePosition
    await syncSinglePosition(configWithoutHedge, "12345");

    // Verify snapshotHedge was NOT called
    expect(snapshotHedgeCalled).toBe(false);
  });

  it("syncLpData does not call getHedgeView when no positions have hedge config", async () => {
    // Config WITHOUT hedge
    const configWithoutHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          // NO hedge field
        },
      },
    };

    // Track if getHedgeView was called
    let getHedgeViewCalled = false;
    mockGetHedgeView = async () => {
      getHedgeViewCalled = true;
      return fakeHedgeView;
    };

    // Mock getAllPositions to return one position
    let getAllPositionsCalls = 0;
    await mock.module("../chain/positions.js", () => ({
      getAllPositions: async () => {
        getAllPositionsCalls++;
        return [fakeRawPosition];
      },
      getPositionCount: async () => 0n,
      getTokenId: async () => 0n,
      getPositionData: (...args: unknown[]) => mockGetPositionData(...args),
    }));

    // Call syncLpData
    const result = await syncLpData(configWithoutHedge);

    // Verify result is valid
    expect(result).toBeDefined();

    // Verify getHedgeView was NOT called
    expect(getHedgeViewCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Hedge config present + getHedgeView succeeds → snapshotHedge is called
// ---------------------------------------------------------------------------

describe("hedge sync wiring — happy path", () => {
  it("syncSinglePosition calls snapshotHedge when hedge config is present and getHedgeView succeeds", async () => {
    // Config WITH hedge
    const configWithHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          hedge: { coin: "HYPE" },
        },
      },
    };

    // Track if snapshotHedge was called
    let snapshotHedgeCalled = false;
    let snapshotHedgeCalledWith: unknown = null;
    mockSnapshotHedge = (view: unknown) => {
      snapshotHedgeCalled = true;
      snapshotHedgeCalledWith = view;
    };

    // Call syncSinglePosition
    const result = await syncSinglePosition(configWithHedge, "12345");

    // Verify result is valid
    expect(result).toBeDefined();
    expect(result.tokenId).toBe("12345");

    // Verify snapshotHedge was called exactly once
    expect(snapshotHedgeCalled).toBe(true);

    // Verify snapshotHedge was called with the hedge view
    expect(snapshotHedgeCalledWith).toEqual(fakeHedgeView);
  });

  it("syncLpData calls snapshotHedge for each position with hedge config", async () => {
    // Config WITH hedge for position 12345
    const configWithHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          hedge: { coin: "HYPE" },
        },
      },
    };

    // Track snapshotHedge calls
    let snapshotHedgeCallCount = 0;
    const snapshotHedgeCallsWithArgs: unknown[] = [];
    mockSnapshotHedge = (view: unknown) => {
      snapshotHedgeCallCount++;
      snapshotHedgeCallsWithArgs.push(view);
    };

    // Mock getAllPositions to return one position
    await mock.module("../chain/positions.js", () => ({
      getAllPositions: async () => [fakeRawPosition],
      getPositionCount: async () => 0n,
      getTokenId: async () => 0n,
      getPositionData: (...args: unknown[]) => mockGetPositionData(...args),
    }));

    // Call syncLpData
    const result = await syncLpData(configWithHedge);

    // Verify result is valid
    expect(result).toBeDefined();
    expect(result.positionCount).toBeGreaterThanOrEqual(0);

    // Verify snapshotHedge was called exactly once
    expect(snapshotHedgeCallCount).toBe(1);

    // Verify snapshotHedge was called with the hedge view
    expect(snapshotHedgeCallsWithArgs[0]).toEqual(fakeHedgeView);
  });

  it("syncSinglePosition calls getHedgeView with correct tokenId when hedge config is present", async () => {
    // Config WITH hedge
    const configWithHedge = {
      ...fakeConfig,
      positions: {
        "12345": {
          openTx: "0x123",
          hedge: { coin: "HYPE" },
        },
      },
    };

    // Track getHedgeView calls
    let getHedgeViewCalled = false;
    let getHedgeViewCalledWithTokenId = "";
    mockGetHedgeView = (...args: unknown[]) => {
      getHedgeViewCalled = true;
      getHedgeViewCalledWithTokenId = args[1] as string;
      return Promise.resolve(fakeHedgeView);
    };

    // Call syncSinglePosition
    await syncSinglePosition(configWithHedge, "12345");

    // Verify getHedgeView was called
    expect(getHedgeViewCalled).toBe(true);

    // Verify getHedgeView was called with correct tokenId
    expect(getHedgeViewCalledWithTokenId).toBe("12345");
  });
});
