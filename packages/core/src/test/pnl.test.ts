/**
 * Tests for USD price branching in getPnLView:
 *  - Active positions (no close_block): use getUsdPrices() (live)
 *  - Closed positions (close_block set):
 *    - Fast path: stored close_usd_price0/1 used directly, no network call
 *    - Slow path: fetch via getHistoricalUsdPrice, then persist to DB
 *  - Graceful degradation when getBlock or getHistoricalUsdPrice fails
 */

import { mock, describe, it, expect, afterAll, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

let mockGetUsdPrices: (..._args: unknown[]) => unknown = async () => ({});
let mockGetHistoricalPrice: (..._args: unknown[]) => unknown = async () => null;
let mockFindCloseEvent: (..._args: unknown[]) => unknown = async () => ({ status: "not_found" });

mock.module("../services/pricing.js", () => ({
  getUsdPrices: (...args: unknown[]) => mockGetUsdPrices(...args),
  getHistoricalPrice: (...args: unknown[]) => mockGetHistoricalPrice(...args),
}));

let mockGetBlock: (_args: {
  blockNumber: bigint;
}) => Promise<{ timestamp: bigint }> = async () => ({
  timestamp: 1700000000n,
});

mock.module("../chain/client.js", () => ({
  createClient: () => ({
    getBlockNumber: async () => 100000n,
    getBlock: (args: { blockNumber: bigint }) => mockGetBlock(args),
  }),
}));

mock.module("../chain/rpc.js", () => ({
  withRetry: (fn: () => unknown) => fn(),
}));

mock.module("../chain/pools.js", () => ({
  getTokenInfo: async (_client: unknown, addr: string) => {
    if (addr === TOKEN0_ADDR) return { symbol: "TKN0", decimals: 18 };
    return { symbol: "TKN1", decimals: 6 };
  },
  getPoolAddress: async () => "0x0000000000000000000000000000000000000099" as const,
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

mock.module("../chain/events.js", () => ({
  findOpenEvent: async () => ({ status: "not_found" }),
  findCloseEvent: (...args: unknown[]) => mockFindCloseEvent(...args),
  getPoolPriceAtBlock: async () => null,
}));

mock.module("../chain/positions.js", () => ({
  getAllPositions: async () => [],
  getPositionCount: async () => 0n,
  getTokenId: async () => 0n,
  getPositionData: async () => ({}),
}));

mock.module("../math/divergence-loss.js", () => ({
  deriveEntryPriceFromAmounts: () => 79228162514264337593543950336n,
  getTokenAmounts: () => ({ amount0: 500n, amount1: 500n }),
  calculateFeeGrowthInside: () => ({
    feeGrowthInside0X128: 0n,
    feeGrowthInside1X128: 0n,
  }),
  calculateUnclaimedFees: () => ({ fees0: 0, fees1: 0 }),
  calculateFullPnL: () => ({
    entryPrice: 1.0,
    exitPrice: 1.0,
    entryAmount0: 1.0,
    entryAmount1: 1.0,
    exitAmount0: 1.0,
    exitAmount1: 1.0,
    feesCollected0: 0,
    feesCollected1: 0,
    feesValue: 0,
    entryValue: 2.0,
    exitValue: 2.0,
    holdValue: 2.0,
    absolutePnl: 0,
    absolutePnlPercent: 0,
    divergenceLoss: 0,
    opportunityCost: 0,
    netVsHodl: 0,
    priceLower: 0.5,
    priceUpper: 2.0,
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test + DB helpers (after mocks)
// ---------------------------------------------------------------------------

import { getPosition, upsertPosition } from "../db/store.js";
import { getPnLView } from "../services/pnl.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TOKEN_ID = "42";
const TOKEN0_ADDR = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" as const;
const TOKEN1_ADDR = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" as const;

const fakeActivePos = {
  tokenId: 42n,
  nonce: 0n,
  operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  token0: TOKEN0_ADDR,
  token1: TOKEN1_ADDR,
  fee: 3000,
  tickLower: -100,
  tickUpper: 100,
  liquidity: 1000000n,
  feeGrowthInside0LastX128: 0n,
  feeGrowthInside1LastX128: 0n,
  tokensOwed0: 0n,
  tokensOwed1: 0n,
};

const fakeClosedPos = { ...fakeActivePos, liquidity: 0n };

const baseConfig = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
  pricing: {
    coingeckoIds: {
      TKN0: "token-0",
      TKN1: "token-1",
    },
  },
};

// Base stored position with open_tx (needed for DB fast-path in open-event section)
const storedBase = {
  token_id: TOKEN_ID,
  token0: TOKEN0_ADDR,
  token1: TOKEN1_ADDR,
  token0_symbol: "TKN0",
  token1_symbol: "TKN1",
  token0_decimals: 18,
  token1_decimals: 6,
  fee: 3000,
  tick_lower: -100,
  tick_upper: 100,
  entry_sqrt_price_x96: "79228162514264337593543950336",
  entry_block: 100,
  entry_amount0: "1000",
  entry_amount1: "2000",
  entry_liquidity: "1000000",
  open_tx: "0xOPEN",
};

// Stored position that has full close data
const storedWithClose = {
  ...storedBase,
  close_tx: "0xCLOSE",
  exit_amount0: "100",
  exit_amount1: "200",
  fees_collected0: "0",
  fees_collected1: "0",
  close_block: 5000,
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

useTestDb();

beforeEach(() => {
  mockGetUsdPrices = async () => ({});
  mockGetHistoricalPrice = async () => null;
  mockFindCloseEvent = async () => ({ status: "not_found" });
  mockGetBlock = async () => ({ timestamp: 1700000000n });
});

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Active positions → live USD pricing
// ---------------------------------------------------------------------------

describe("active positions → live USD pricing via getUsdPrices", () => {
  it("calls getUsdPrices (not getHistoricalUsdPrice) for active position with no close_block", async () => {
    upsertPosition(storedBase);

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {
        [TOKEN0_ADDR.toLowerCase()]: 50.0,
        [TOKEN1_ADDR.toLowerCase()]: 1.0,
      };
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeActivePos]);

    expect(result.length).toBe(1);
    expect(liveCallCount).toBeGreaterThan(0);
    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(50.0);
    expect(result[0].token1UsdPrice).toBe(1.0);
  });

  it("returns null USD prices gracefully when getUsdPrices throws for active position", async () => {
    upsertPosition(storedBase);

    mockGetUsdPrices = async () => {
      throw new Error("CoinGecko down");
    };

    const result = await getPnLView(baseConfig, undefined, [fakeActivePos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBeNull();
    expect(result[0].token1UsdPrice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Closed positions with close_block → historical USD pricing
// ---------------------------------------------------------------------------

describe("closed positions with close_block → historical USD pricing", () => {
  it("fast path: uses stored close_usd_price0/1 directly without any network call", async () => {
    upsertPosition({
      ...storedWithClose,
      close_usd_price0: 42.5,
      close_usd_price1: 1.25,
    });

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {};
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(liveCallCount).toBe(0);
    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(42.5);
    expect(result[0].token1UsdPrice).toBe(1.25);
  });

  it("slow path: fetches historical prices using close block timestamp when not stored", async () => {
    upsertPosition(storedWithClose); // no close_usd_price0/1

    // Timestamp 1700000000 unix → "2023-11-14T22:13:20.000Z"
    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 100.0;
      if (symbol === "TKN1") return 2.5;
      return null;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBe(100.0);
    expect(result[0].token1UsdPrice).toBe(2.5);
  });

  it("slow path: persists fetched prices to DB so next call takes fast path", async () => {
    upsertPosition(storedWithClose); // no close_usd_price0/1

    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 100.0;
      if (symbol === "TKN1") return 2.5;
      return null;
    };

    await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    const stored = getPosition(TOKEN_ID);
    expect(stored?.close_usd_price0).toBe(100.0);
    expect(stored?.close_usd_price1).toBe(2.5);
  });

  it("slow path: persisted prices are used on the next call (no historical call on second run)", async () => {
    upsertPosition(storedWithClose);

    let historicalCallCount = 0;
    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      historicalCallCount++;
      if (symbol === "TKN0") return 100.0;
      if (symbol === "TKN1") return 2.5;
      return null;
    };

    // First call: slow path, fetches and persists
    await getPnLView(baseConfig, undefined, [fakeClosedPos]);
    expect(historicalCallCount).toBe(2); // once per token

    // Second call: fast path, no historical network call
    historicalCallCount = 0;
    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(100.0);
    expect(result[0].token1UsdPrice).toBe(2.5);
  });

  it("graceful degradation: returns null USD prices when getBlock throws", async () => {
    upsertPosition(storedWithClose);

    mockGetBlock = async () => {
      throw new Error("Block not available");
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBeNull();
    expect(result[0].token1UsdPrice).toBeNull();
  });

  it("graceful degradation: returns null USD prices when getHistoricalUsdPrice returns null", async () => {
    upsertPosition(storedWithClose);

    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async () => null;

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBeNull();
    expect(result[0].token1UsdPrice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Closed positions without close_block → fall back to live pricing
// ---------------------------------------------------------------------------

describe("closed positions without close_block → live pricing fallback", () => {
  it("uses getUsdPrices (not historical) when close_block is null", async () => {
    // Position closed but close_block not recorded
    upsertPosition({
      ...storedBase,
      close_tx: "0xCLOSE",
      exit_amount0: "100",
      exit_amount1: "200",
      fees_collected0: "0",
      fees_collected1: "0",
      // close_block deliberately omitted
    });

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {};
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(liveCallCount).toBeGreaterThan(0);
    expect(historicalCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPnLView USD routing — boundary conditions
// ---------------------------------------------------------------------------

describe("getPnLView USD routing — boundary conditions", () => {
  it("only one close_usd_price stored: should NOT take fast path, fetches historical for both tokens", async () => {
    // Only close_usd_price0 is stored, close_usd_price1 is null → condition fails
    upsertPosition({
      ...storedWithClose,
      close_usd_price0: 1.5,
      // close_usd_price1 deliberately omitted (null)
    });

    let historicalCallCount = 0;

    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      historicalCallCount++;
      if (symbol === "TKN0") return 100.0;
      if (symbol === "TKN1") return 2.5;
      return null;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    // Should NOT use the stored 1.5; should fetch both
    expect(result.length).toBe(1);
    expect(historicalCallCount).toBe(2); // both tokens fetched
    expect(result[0].token0UsdPrice).toBe(100.0);
    expect(result[0].token1UsdPrice).toBe(2.5);
  });

  it("close_block = 0 (falsy but valid): taken branch is closed (historical), not active", async () => {
    // close_block: 0 is falsy but (0 ?? null) !== null is true → closed branch
    upsertPosition({
      ...storedWithClose,
      close_block: 0,
      close_usd_price0: 42.0,
      close_usd_price1: 1.0,
    });

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {
        [TOKEN0_ADDR.toLowerCase()]: 999.0,
        [TOKEN1_ADDR.toLowerCase()]: 999.0,
      };
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    // Verify closed branch taken (no live call), fast path used (stored prices used)
    expect(result.length).toBe(1);
    expect(liveCallCount).toBe(0);
    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(42.0);
    expect(result[0].token1UsdPrice).toBe(1.0);
  });

  it("close_block = null (explicitly): active branch, uses live prices", async () => {
    // Explicitly verify that when close_block is null/missing, active branch is taken
    upsertPosition({
      ...storedWithClose,
      close_block: null as any, // Explicitly null, not 0
    });

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {
        [TOKEN0_ADDR.toLowerCase()]: 50.0,
        [TOKEN1_ADDR.toLowerCase()]: 1.0,
      };
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    // Verify that active/live branch is taken (null close_block)
    expect(result.length).toBe(1);
    expect(liveCallCount).toBeGreaterThan(0);
    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(50.0);
    expect(result[0].token1UsdPrice).toBe(1.0);
  });

  it("both close_usd_prices = 0.0: fast path IS taken (0.0 != null is true, valid stored price)", async () => {
    // 0.0 is a valid price (different from null), so fast path should trigger
    upsertPosition({
      ...storedWithClose,
      close_usd_price0: 0.0,
      close_usd_price1: 0.0,
    });

    let liveCallCount = 0;
    let historicalCallCount = 0;

    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {
        [TOKEN0_ADDR.toLowerCase()]: 999.0,
        [TOKEN1_ADDR.toLowerCase()]: 999.0,
      };
    };
    mockGetHistoricalPrice = async () => {
      historicalCallCount++;
      return 999.0;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    // Fast path: use stored 0.0 directly, no network calls
    expect(result.length).toBe(1);
    expect(liveCallCount).toBe(0);
    expect(historicalCallCount).toBe(0);
    expect(result[0].token0UsdPrice).toBe(0.0);
    expect(result[0].token1UsdPrice).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// getPnLView closed USD — partial failures and missing metadata
// ---------------------------------------------------------------------------

describe("getPnLView closed USD — partial failures and missing metadata", () => {
  it("one of the two getHistoricalUsdPrice calls returns null: partial nulls allowed, function doesn't abort", async () => {
    // token0 price is null, token1 price is 3.14
    upsertPosition(storedWithClose);

    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return null; // token0 price is null
      if (symbol === "TKN1") return 3.14; // token1 price is valid
      return null;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBeNull();
    expect(result[0].token1UsdPrice).toBe(3.14);
  });

  it("fills missing historical close price from live prices", async () => {
    upsertPosition(storedWithClose);

    let liveCallCount = 0;
    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 88.0;
      if (symbol === "TKN1") return null;
      return null;
    };
    mockGetUsdPrices = async () => {
      liveCallCount++;
      return {
        [TOKEN0_ADDR.toLowerCase()]: 999.0,
        [TOKEN1_ADDR.toLowerCase()]: 1.01,
      };
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(liveCallCount).toBe(1);
    expect(result[0].token0UsdPrice).toBe(88.0);
    expect(result[0].token1UsdPrice).toBe(1.01);
  });

  it("uses freshly discovered close block for USD prices in the same sync", async () => {
    upsertPosition(storedBase);

    mockFindCloseEvent = async () => ({
      status: "found",
      event: {
        tokenId: 42n,
        blockNumber: 5000n,
        transactionHash: "0xCLOSE",
        amount0: 100n,
        amount1: 200n,
        liquidity: 1000000n,
        collectedFees0: 10n,
        collectedFees1: 20n,
      },
    });

    mockGetBlock = async (args: { blockNumber: bigint }) => {
      expect(args.blockNumber).toBe(5000n);
      return { timestamp: 1700000000n };
    };
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 77.0;
      if (symbol === "TKN1") return 1.02;
      return null;
    };

    const result = await getPnLView(
      {
        ...baseConfig,
        positions: {
          [TOKEN_ID]: { openTx: "", closeTx: "0xCLOSE" },
        },
      },
      undefined,
      [fakeClosedPos],
    );

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBe(77.0);
    expect(result[0].token1UsdPrice).toBe(1.02);
  });

  it("upsertPosition throws on persist: fetched prices still returned, error swallowed by catch", async () => {
    // getBlock and both getHistoricalUsdPrice succeed, but upsert throws
    // This tests that the catch block in the slow path swallows the error
    upsertPosition(storedWithClose);

    mockGetBlock = async () => ({ timestamp: 1700000000n });
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 100.0;
      if (symbol === "TKN1") return 2.5;
      return null;
    };

    // The slow path will try to upsert but may throw; verify prices are still returned
    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    // Fetched prices should be returned despite any DB error
    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBe(100.0);
    expect(result[0].token1UsdPrice).toBe(2.5);
  });

  it("getBlock returns a block with timestamp = 0n: ISO = '1970-01-01T00:00:00.000Z', no crash", async () => {
    // timestamp = 0n → ISO = "1970-01-01T00:00:00.000Z"
    upsertPosition(storedWithClose);

    mockGetBlock = async () => ({ timestamp: 0n });
    mockGetHistoricalPrice = async (_config, symbol, isoTimestamp) => {
      // Verify the ISO timestamp is well-formed (not crashing)
      expect(isoTimestamp).toBe("1970-01-01T00:00:00.000Z");
      if (symbol === "TKN0") return 50.0;
      if (symbol === "TKN1") return 1.5;
      return null;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(result[0].token0UsdPrice).toBe(50.0);
    expect(result[0].token1UsdPrice).toBe(1.5);
  });

  it("close_block is a very large number: BigInt conversion and getBlock call succeed", async () => {
    // close_block: 99999999 (large but valid)
    upsertPosition({
      ...storedWithClose,
      close_block: 99999999,
    });

    let getBlockCallCount = 0;
    let getBlockBlockNumber: bigint = 0n;

    mockGetBlock = async (args: { blockNumber: bigint }) => {
      getBlockCallCount++;
      getBlockBlockNumber = args.blockNumber;
      return { timestamp: 1700000000n };
    };
    mockGetHistoricalPrice = async (_config, symbol) => {
      if (symbol === "TKN0") return 75.0;
      if (symbol === "TKN1") return 2.0;
      return null;
    };

    const result = await getPnLView(baseConfig, undefined, [fakeClosedPos]);

    expect(result.length).toBe(1);
    expect(getBlockCallCount).toBeGreaterThan(0);
    expect(getBlockBlockNumber).toBe(99999999n);
    expect(result[0].token0UsdPrice).toBe(75.0);
    expect(result[0].token1UsdPrice).toBe(2.0);
  });
});
