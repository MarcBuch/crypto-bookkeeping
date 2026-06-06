import { describe, it, expect } from "bun:test";

import { getDb } from "../../db/schema.js";
import { upsertPosition, getPosition } from "../../db/store.js";
import { useTestDb } from "./db.js";

// Module-level variables for cross-describe path comparison
let firstDescribeDir: string = "";
let secondDescribeDir: string = "";

/**
 * Minimal position for testing
 */
function minimalPosition(tokenId: string) {
  return {
    token_id: tokenId,
    token0: "0x" + "a".repeat(40),
    token1: "0x" + "b".repeat(40),
    token0_symbol: "TKN0",
    token1_symbol: "TKN1",
    token0_decimals: 18,
    token1_decimals: 6,
    fee: 3000,
    tick_lower: -887272,
    tick_upper: 887272,
    entry_sqrt_price_x96: "1461446703485210103287273052203988822378723720",
    entry_block: 100,
    entry_amount0: "1000000000000000000",
    entry_amount1: "1000000",
    entry_liquidity: "1000000000000000000",
  };
}

describe("DB isolation - unique directories", () => {
  useTestDb();

  let test1Dir: string;
  let test2Dir: string;

  it("test 1: captures its unique LP_TRACKER_DATA_DIR", () => {
    test1Dir = process.env.LP_TRACKER_DATA_DIR || "";
    expect(test1Dir).toBeTruthy();
    expect(test1Dir).toContain("lp-tracker-test-");
  });

  it("test 2: gets a different LP_TRACKER_DATA_DIR than test 1", () => {
    test2Dir = process.env.LP_TRACKER_DATA_DIR || "";
    expect(test2Dir).toBeTruthy();
    expect(test2Dir).toContain("lp-tracker-test-");
    expect(test2Dir).not.toEqual(test1Dir);
  });
});

describe("DB isolation - fresh DB per test (no data bleed)", () => {
  useTestDb();

  it("test 1: inserts a position into DB", () => {
    const pos = minimalPosition("123456");
    upsertPosition(pos);

    // Verify it was inserted
    const retrieved = getPosition("123456");
    expect(retrieved).toBeTruthy();
    expect(retrieved?.token_id).toBe("123456");
  });

  it("test 2: has a fresh empty DB (no data from test 1)", () => {
    // Try to retrieve the position that test 1 inserted
    const retrieved = getPosition("123456");

    // Should not exist in this fresh DB
    expect(retrieved).toBeNull();
  });
});

describe("DB isolation - singleton independence", () => {
  useTestDb();

  it("test 1: inserts and DB is populated", () => {
    const pos = minimalPosition("token1");
    upsertPosition(pos);

    const db = getDb();
    expect(db).toBeTruthy();

    const retrieved = getPosition("token1");
    expect(retrieved?.token_id).toBe("token1");
  });

  it("test 2: getDb() returns a new instance with fresh state", () => {
    // This getDb() call should return a new DB instance (different from test 1's)
    const db = getDb();
    expect(db).toBeTruthy();

    // The DB should be empty
    const retrieved = getPosition("token1");
    expect(retrieved).toBeNull();
  });

  it("test 3: can insert different data without test 1 or test 2 interference", () => {
    const pos = minimalPosition("token3");
    upsertPosition(pos);

    const retrieved = getPosition("token3");
    expect(retrieved?.token_id).toBe("token3");

    // Verify test 1's data is not present
    const test1Data = getPosition("token1");
    expect(test1Data).toBeNull();
  });
});

describe("DB isolation - two useTestDb() calls in same file", () => {
  useTestDb();

  it("first describe: captures env var", () => {
    firstDescribeDir = process.env.LP_TRACKER_DATA_DIR || "";
    expect(firstDescribeDir).toBeTruthy();
    expect(firstDescribeDir).toContain("lp-tracker-test-");

    // Insert data in first describe
    const pos = minimalPosition("first-describe-token");
    upsertPosition(pos);

    const retrieved = getPosition("first-describe-token");
    expect(retrieved?.token_id).toBe("first-describe-token");
  });

  it("first describe: each test gets its own fresh DB (before/afterEach resets)", () => {
    // Each test gets a fresh DB because beforeEach calls resetDb()
    // This is the correct isolation behavior
    firstDescribeDir = process.env.LP_TRACKER_DATA_DIR || "";
    expect(firstDescribeDir).toBeTruthy();

    // Data from previous test should not exist (fresh DB per test)
    const retrieved = getPosition("first-describe-token");
    expect(retrieved).toBeNull();

    // But we can insert fresh data in this test
    const pos = minimalPosition("new-token-in-first");
    upsertPosition(pos);
    const newRetrieved = getPosition("new-token-in-first");
    expect(newRetrieved?.token_id).toBe("new-token-in-first");
  });
});

describe("DB isolation - second useTestDb() block in same file", () => {
  useTestDb();

  it("second describe: gets its own isolated directory", () => {
    secondDescribeDir = process.env.LP_TRACKER_DATA_DIR || "";
    expect(secondDescribeDir).toBeTruthy();
    expect(secondDescribeDir).toContain("lp-tracker-test-");

    // Cross-describe assertion: verify the directories differ
    expect(firstDescribeDir).toBeTruthy();
    expect(secondDescribeDir).not.toEqual(firstDescribeDir);

    // This should be a fresh DB, not having data from "first describe"
    const retrieved = getPosition("first-describe-token");
    expect(retrieved).toBeNull();
  });

  it("second describe: can insert and retrieve its own data", () => {
    const pos = minimalPosition("second-describe-token");
    upsertPosition(pos);

    const retrieved = getPosition("second-describe-token");
    expect(retrieved?.token_id).toBe("second-describe-token");

    // Verify first describe's data is not present
    const firstData = getPosition("first-describe-token");
    expect(firstData).toBeNull();
  });
});
