/**
 * Adversarial tests for syncLpTaxFlows
 *
 * Covers:
 *   m1t2 — missing/null position data, zero amounts
 *   m1t3 — idempotency, EUR preservation on re-run
 *   m1t4 — block timestamp resolution (RPC failure, deduplication, zero-timestamp)
 *   m1t5 — LP entry construction (decimal formatting, ID contract, direction)
 *   m1t6 — syncTaxTransactions integration (LP flows in combined sync)
 */

import { describe, expect, it } from "bun:test";

import type { HypersyncClient } from "@envio-dev/hypersync-client";

import type { Client } from "../chain/client.js";
import { getTaxTransaction, updateTaxTransactionEurValues, upsertPosition } from "../db/store.js";
import {
  syncLpTaxFlows,
  syncTaxTransactions,
} from "../services/tax-transactions.js";
import { useTestDb } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALLET = "0xabcdef1234567890abcdef1234567890abcdef12" as `0x${string}`;
const TOKEN0 = "0x5555555555555555555555555555555555555555"; // WHYPE
const TOKEN1 = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC
const POSITION_MANAGER = "0xead19ae861c29bbb2101e834922b2feee69b9091";

const OPEN_TX =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const CLOSE_TX =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    wallet: WALLET,
    pricing: {},
    rpc: "https://rpc.example.com",
    chainId: 999,
    contracts: {
      factory: "0xff7b3e8c00e57ea31477c32a5b52a58eea47b072" as `0x${string}`,
      positionManager: POSITION_MANAGER as `0x${string}`,
      quoter: "0x239f11a7a3e08f2b8110d4ca9f6b95d4c8865258" as `0x${string}`,
      swapRouter: "0x1ebdfc75ffe3ba3de61e7138a3e8706ac841af9b" as `0x${string}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Viem client mock.
 * blockTimestamps: blockNumber → timestamp bigint; if not in map, throws (simulates RPC error).
 * Pass null value to simulate block with timestamp = 0n (falsy BigInt).
 */
function makeViemMock(
  blockTimestamps: Record<number, bigint | "throw"> = {},
  getBlockCalls?: number[],
): Client {
  return {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const num = Number(blockNumber);
      if (getBlockCalls) getBlockCalls.push(num);
      const ts = blockTimestamps[num];
      if (ts === "throw" || ts === undefined) {
        throw new Error(`Mock RPC failure for block ${num}`);
      }
      return { timestamp: ts };
    },
  } as unknown as Client;
}

/** A minimal closed position with both tokens and all optional fields. */
function makePosition(
  overrides: Partial<{
    token_id: string;
    open_tx: string | null;
    close_tx: string | null;
    entry_block: number | null;
    close_block: number | null;
    entry_amount0: string | null;
    entry_amount1: string | null;
    exit_amount0: string | null;
    exit_amount1: string | null;
    fees_collected0: string | null;
    fees_collected1: string | null;
  }> = {},
) {
  upsertPosition({
    token_id: overrides.token_id ?? "123456",
    token0: TOKEN0,
    token1: TOKEN1,
    token0_symbol: "WHYPE",
    token1_symbol: "USDC",
    token0_decimals: 18,
    token1_decimals: 6,
    fee: 3000,
    tick_lower: -100,
    tick_upper: 100,
    entry_sqrt_price_x96: null,
    entry_block: overrides.entry_block !== undefined ? overrides.entry_block : 1000,
    entry_amount0: overrides.entry_amount0 !== undefined ? overrides.entry_amount0 : "1000000000000000000",
    entry_amount1: overrides.entry_amount1 !== undefined ? overrides.entry_amount1 : "2000000",
    entry_liquidity: null,
    open_tx: overrides.open_tx !== undefined ? overrides.open_tx : OPEN_TX,
    close_tx: overrides.close_tx !== undefined ? overrides.close_tx : CLOSE_TX,
    exit_amount0: overrides.exit_amount0 !== undefined ? overrides.exit_amount0 : "900000000000000000",
    exit_amount1: overrides.exit_amount1 !== undefined ? overrides.exit_amount1 : "1900000",
    fees_collected0: overrides.fees_collected0 !== undefined ? overrides.fees_collected0 : "50000000000000000",
    fees_collected1: overrides.fees_collected1 !== undefined ? overrides.fees_collected1 : "500000",
    close_block: overrides.close_block !== undefined ? overrides.close_block : 2000,
    close_usd_price0: null,
    close_usd_price1: null,
    exit_sqrt_price_x96: null,
  });
}

/** Full default viem mock for blocks 1000 and 2000 */
function makeDefaultViemMock(getBlockCalls?: number[]): Client {
  return makeViemMock({ 1000: 1700000000n, 2000: 1700100000n }, getBlockCalls);
}

// HyperSync no-op mock (returns nothing, terminates pagination)
const noOpHyperSyncClient = {
  get: async (_query: unknown) => ({
    archiveHeight: 99999,
    nextBlock: 99999,
    totalExecutionTime: 1,
    data: { blocks: [], transactions: [], logs: [], traces: [] },
  }),
} as unknown as HypersyncClient;

// Explorer fetcher that returns no results
const noOpFetcher = async (_url: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    status: "0",
    message: "No transactions found",
    result: "No transactions found",
  }),
});

// ===========================================================================
// Suite 1 (m1t2): missing/null position data, zero amounts
// ===========================================================================

describe("m1t2 — missing/null position data, zero amounts", () => {
  useTestDb();

  it("empty positions table: synced=0, skipped=0", async () => {
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({}),
    });
    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("position with no open_tx: no deposit entries created", async () => {
    makePosition({ open_tx: null });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    // No deposit entries — withdrawal and fee entries are still created if close_tx present
    const depositId0 = `lp:deposit:${OPEN_TX}:${TOKEN0}:0`;
    expect(getTaxTransaction(depositId0)).toBeNull();
  });

  it("position with null entry_amount0 and null entry_amount1: position skipped", async () => {
    makePosition({ entry_amount0: null, entry_amount1: null });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(result.skipped).toBe(1);
    // No deposit entries
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).toBeNull();
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`)).toBeNull();
  });

  it("position with entry_amount0='0' and entry_amount1='0': position skipped", async () => {
    makePosition({ entry_amount0: "0", entry_amount1: "0" });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(result.skipped).toBe(1);
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).toBeNull();
  });

  it("position with open_tx and non-zero entry amounts but entry_block=null: counted as skipped, no entry created", async () => {
    makePosition({ entry_block: null });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({}), // entry_block null → block lookup skipped
    });
    // The bug-fix branch: skipped += 1 when hasEntry && entry_block === null
    expect(result.skipped).toBe(1);
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).toBeNull();
  });

  it("only token0 entry amount set: only token0 deposit entry created", async () => {
    makePosition({ entry_amount1: null });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    // token0 deposit created
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
    // token1 deposit NOT created
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`)).toBeNull();
  });

  it("position with no close_tx: no withdrawal or fee entries created", async () => {
    makePosition({ close_tx: null, close_block: null });
    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)).toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)).toBeNull();
  });

  it("position with close_tx but exit_amount0='0' and exit_amount1='0': no withdrawal entries", async () => {
    makePosition({ exit_amount0: "0", exit_amount1: "0" });
    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)).toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN1}:1`)).toBeNull();
  });

  it("position with close_tx but fees_collected0='0' and fees_collected1='0': no fee entries", async () => {
    makePosition({ fees_collected0: "0", fees_collected1: "0" });
    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)).toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN1}:1`)).toBeNull();
  });

  it("fully-populated closed position: all 6 entries created (2 deposits, 2 withdrawals, 2 fees)", async () => {
    makePosition({});
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeDefaultViemMock(),
    });
    expect(result.synced).toBe(6);
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`)).not.toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN1}:1`)).not.toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN1}:1`)).not.toBeNull();
  });
});

// ===========================================================================
// Suite 2 (m1t3): idempotency, EUR preservation
// ===========================================================================

describe("m1t3 — idempotency and EUR preservation on re-run", () => {
  useTestDb();

  it("running syncLpTaxFlows twice produces the same entries without duplicates", async () => {
    makePosition({});

    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });
    const result2 = await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    // Second run still reports synced entries (upsert = write, not insert-only)
    expect(result2.synced).toBe(6);

    // DB has exactly 6 entries (no duplicates)
    const { listTaxTransactions } = await import("../db/store.js");
    const allRows = listTaxTransactions();
    const lpRows = allRows.filter((r) => r.source === "lp-events");
    expect(lpRows).toHaveLength(6);
  });

  it("EUR values set manually before re-sync are NOT overwritten", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const depositId = `lp:deposit:${OPEN_TX}:${TOKEN0}:0`;
    updateTaxTransactionEurValues(depositId, {
      cost_eur: "1234.00",
      proceeds_eur: null,
      gain_eur: "-1234.00",
    });

    const rowBefore = getTaxTransaction(depositId);
    expect(rowBefore!.cost_eur).toBe("1234.00");

    // Re-sync
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const rowAfter = getTaxTransaction(depositId);
    // EUR values must be preserved by the ON CONFLICT ... SET which excludes EUR columns
    expect(rowAfter!.cost_eur).toBe("1234.00");
    expect(rowAfter!.gain_eur).toBe("-1234.00");
  });

  it("adding a new position on second run creates its entries while preserving existing ones", async () => {
    // First run: one position
    makePosition({ token_id: "111111" });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const open2 = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const close2 = "0x4444444444444444444444444444444444444444444444444444444444444444";

    // Second run: add a second position
    makePosition({
      token_id: "222222",
      open_tx: open2,
      close_tx: close2,
      entry_block: 3000,
      close_block: 4000,
    });
    const result2 = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: 1700000000n, 2000: 1700100000n, 3000: 1700200000n, 4000: 1700300000n }),
    });

    expect(result2.synced).toBe(12); // 6 from pos1 (upserted) + 6 from pos2 (new)
    // Existing entries still present
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
    // New entries present
    expect(getTaxTransaction(`lp:deposit:${open2}:${TOKEN0}:0`)).not.toBeNull();
  });
});

// ===========================================================================
// Suite 3 (m1t4): block timestamp resolution
// ===========================================================================

describe("m1t4 — block timestamp resolution", () => {
  useTestDb();

  it("RPC failure for entry block: entry still created with time_stamp=null", async () => {
    makePosition({ close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null });
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: "throw" }),
    });
    expect(result.synced).toBeGreaterThanOrEqual(1);
    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.time_stamp).toBeNull();
  });

  it("RPC failure for close block: withdrawal and fee entries still created with time_stamp=null", async () => {
    makePosition({ entry_amount0: null, entry_amount1: null }); // skip deposits
    const result = await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: 1700000000n, 2000: "throw" }),
    });
    expect(result.synced).toBeGreaterThanOrEqual(1);
    const row = getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.time_stamp).toBeNull();
  });

  it("same block number shared by two positions: getBlock called exactly once for that block", async () => {
    const getBlockCalls: number[] = [];
    // Two positions using the same entry_block = 1000
    makePosition({ token_id: "111111", open_tx: OPEN_TX, close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null });

    const open2 = "0x5555555555555555555555555555555555555555555555555555555555555555";
    makePosition({ token_id: "222222", open_tx: open2, close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null, entry_block: 1000 });

    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: 1700000000n }, getBlockCalls),
    });

    // Block 1000 should only be fetched once regardless of how many positions use it
    expect(getBlockCalls.filter((b) => b === 1000)).toHaveLength(1);
  });

  it("block.timestamp = 0n (falsy BigInt): treated as null, entry created with time_stamp=null", async () => {
    makePosition({ close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null });
    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: 0n }),
    });
    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    // 0n is falsy, so the implementation treats it as null
    expect(row!.time_stamp).toBeNull();
  });

  it("valid block timestamp: entry has correct ISO 8601 time_stamp", async () => {
    const unixTs = 1700000000;
    makePosition({ close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null });
    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: BigInt(unixTs) }),
    });
    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.time_stamp).toBe(new Date(unixTs * 1000).toISOString());
  });
});

// ===========================================================================
// Suite 4 (m1t5): LP entry construction — ID contract, direction, decimals
// ===========================================================================

describe("m1t5 — LP entry construction", () => {
  useTestDb();

  it("deposit entry: from_address=wallet, to_address=positionManager, outgoing set, incoming null", async () => {
    makePosition({ close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.from_address).toBe(WALLET.toLowerCase());
    expect(row!.to_address?.toLowerCase()).toBe(POSITION_MANAGER.toLowerCase());
    expect(row!.outgoing_quantity).not.toBeNull();
    expect(row!.outgoing_asset).toBe("WHYPE");
    expect(row!.incoming_quantity).toBeNull();
    expect(row!.incoming_asset).toBeNull();
    expect(row!.transaction_type).toBe("lp-deposit");
  });

  it("withdrawal entry: from_address=null, incoming set, outgoing null", async () => {
    makePosition({ entry_amount0: null, entry_amount1: null }); // skip deposits
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.from_address).toBeNull();
    expect(row!.incoming_quantity).not.toBeNull();
    expect(row!.incoming_asset).toBe("WHYPE");
    expect(row!.outgoing_quantity).toBeNull();
    expect(row!.outgoing_asset).toBeNull();
    expect(row!.transaction_type).toBe("lp-withdrawal");
  });

  it("fee entry: incoming set, outgoing null, transaction_type=lp-fees", async () => {
    makePosition({ entry_amount0: null, entry_amount1: null, exit_amount0: null, exit_amount1: null }); // only fees
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`);
    expect(row).not.toBeNull();
    expect(row!.incoming_quantity).not.toBeNull();
    expect(row!.incoming_asset).toBe("WHYPE");
    expect(row!.outgoing_quantity).toBeNull();
    expect(row!.transaction_type).toBe("lp-fees");
  });

  it("ID contract: lp:{type}:{hash}:{tokenAddress}:{tokenIndex}", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    // Verify all 6 IDs match the contract
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`)).not.toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN1}:1`)).not.toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN1}:1`)).not.toBeNull();
  });

  it("WHYPE 18-decimal formatting: 1e18 wei → outgoing_quantity='1'", async () => {
    makePosition({
      entry_amount0: "1000000000000000000", // 1 WHYPE
      entry_amount1: null,
      close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null,
    });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row!.outgoing_quantity).toBe("1");
  });

  it("WHYPE 18-decimal formatting: 1.5e18 wei → outgoing_quantity='1.5'", async () => {
    makePosition({
      entry_amount0: "1500000000000000000", // 1.5 WHYPE
      entry_amount1: null,
      close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null,
    });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(row!.outgoing_quantity).toBe("1.5");
  });

  it("USDC 6-decimal formatting: 1_000_000 raw → outgoing_quantity='1'", async () => {
    makePosition({
      entry_amount0: null,
      entry_amount1: "1000000", // 1 USDC
      close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null,
    });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`);
    expect(row!.outgoing_quantity).toBe("1");
  });

  it("USDC 6-decimal formatting: 9_538_000 raw → outgoing_quantity='9.538'", async () => {
    // Simulates the real fee harvest amount from the bug report
    makePosition({
      entry_amount0: null,
      entry_amount1: "9538000",
      close_tx: null, close_block: null, exit_amount0: null, exit_amount1: null, fees_collected0: null, fees_collected1: null,
    });
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const row = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`);
    expect(row!.outgoing_quantity).toBe("9.538");
  });

  it("source field is 'lp-events' for all entry types", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const ids = [
      `lp:deposit:${OPEN_TX}:${TOKEN0}:0`,
      `lp:deposit:${OPEN_TX}:${TOKEN1}:1`,
      `lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`,
      `lp:withdrawal:${CLOSE_TX}:${TOKEN1}:1`,
      `lp:fees:${CLOSE_TX}:${TOKEN0}:0`,
      `lp:fees:${CLOSE_TX}:${TOKEN1}:1`,
    ];
    for (const id of ids) {
      const row = getTaxTransaction(id);
      expect(row).not.toBeNull();
      expect(row!.source).toBe("lp-events");
    }
  });

  it("is_error=0 for all entry types", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const ids = [
      `lp:deposit:${OPEN_TX}:${TOKEN0}:0`,
      `lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`,
      `lp:fees:${CLOSE_TX}:${TOKEN0}:0`,
    ];
    for (const id of ids) {
      expect(getTaxTransaction(id)!.is_error).toBe(0);
    }
  });

  it("block_number stored correctly on each entry", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)!.block_number).toBe(1000);
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)!.block_number).toBe(2000);
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)!.block_number).toBe(2000);
  });

  it("contract_address matches token address for each entry", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const deposit0 = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(deposit0!.contract_address).toBe(TOKEN0);

    const deposit1 = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`);
    expect(deposit1!.contract_address).toBe(TOKEN1);
  });

  it("token_symbol and token_decimal stored from position metadata", async () => {
    makePosition({});
    await syncLpTaxFlows(makeConfig(), { viemClient: makeDefaultViemMock() });

    const deposit0 = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`);
    expect(deposit0!.token_symbol).toBe("WHYPE");
    expect(deposit0!.token_decimal).toBe(18);

    const deposit1 = getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN1}:1`);
    expect(deposit1!.token_symbol).toBe("USDC");
    expect(deposit1!.token_decimal).toBe(6);
  });

  it("two positions in same pool with different open_tx produce distinct IDs", async () => {
    const open2 = "0x9999999999999999999999999999999999999999999999999999999999999999";
    const close2 = "0x8888888888888888888888888888888888888888888888888888888888888888";
    makePosition({ token_id: "111111", open_tx: OPEN_TX, close_tx: CLOSE_TX });
    makePosition({ token_id: "222222", open_tx: open2, close_tx: close2, entry_block: 3000, close_block: 4000 });

    await syncLpTaxFlows(makeConfig(), {
      viemClient: makeViemMock({ 1000: 1700000000n, 2000: 1700100000n, 3000: 1700200000n, 4000: 1700300000n }),
    });

    // All 12 IDs are distinct
    const { listTaxTransactions } = await import("../db/store.js");
    const lpRows = listTaxTransactions().filter((r) => r.source === "lp-events");
    expect(lpRows).toHaveLength(12);
    const uniqueIds = new Set(lpRows.map((r) => r.id));
    expect(uniqueIds.size).toBe(12);
  });
});

// ===========================================================================
// Suite 5 (m1t6): syncTaxTransactions integration
// ===========================================================================

describe("m1t6 — syncTaxTransactions integration", () => {
  useTestDb();

  it("LP entries appear in DB when syncTaxTransactions is called", async () => {
    makePosition({});

    await syncTaxTransactions(
      { ...makeConfig(), tax: { hyperSyncUrl: "x", hyperSyncApiToken: "tok" }, logsRpc: undefined },
      {
        fetcher: noOpFetcher,
        hyperSyncClient: noOpHyperSyncClient,
        viemClient: makeDefaultViemMock(),
      },
    );

    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:withdrawal:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
    expect(getTaxTransaction(`lp:fees:${CLOSE_TX}:${TOKEN0}:0`)).not.toBeNull();
  });

  it("LP synced count is included in the summary total", async () => {
    makePosition({});

    const summary = await syncTaxTransactions(
      { ...makeConfig(), tax: { hyperSyncUrl: "x", hyperSyncApiToken: "tok" }, logsRpc: undefined },
      {
        fetcher: noOpFetcher,
        hyperSyncClient: noOpHyperSyncClient,
        viemClient: makeDefaultViemMock(),
      },
    );

    // HyperSync returns nothing, explorer returns nothing → all synced entries are from LP
    expect(summary.synced).toBe(6);
  });

  it("LP sync runs even when HyperSync returns no transactions", async () => {
    makePosition({});

    // HyperSync mock that returns zero transactions
    const emptyHyperSyncClient = {
      get: async (_query: unknown) => ({
        archiveHeight: 99999,
        nextBlock: 99999,
        totalExecutionTime: 1,
        data: { blocks: [], transactions: [], logs: [], traces: [] },
      }),
    } as unknown as HypersyncClient;

    const summary = await syncTaxTransactions(
      { ...makeConfig(), tax: { hyperSyncUrl: "x", hyperSyncApiToken: "tok" }, logsRpc: undefined },
      {
        fetcher: noOpFetcher,
        hyperSyncClient: emptyHyperSyncClient,
        viemClient: makeDefaultViemMock(),
      },
    );

    expect(summary.synced).toBe(6);
    expect(getTaxTransaction(`lp:deposit:${OPEN_TX}:${TOKEN0}:0`)).not.toBeNull();
  });

  it("LP entries do not affect the incremental sync watermark (block_number tracking)", async () => {
    makePosition({}); // positions at blocks 1000 (entry) and 2000 (close)

    const summary = await syncTaxTransactions(
      { ...makeConfig(), tax: { hyperSyncUrl: "x", hyperSyncApiToken: "tok" }, logsRpc: undefined },
      {
        fetcher: noOpFetcher,
        hyperSyncClient: noOpHyperSyncClient,
        viemClient: makeDefaultViemMock(),
      },
    );

    // latestBlockNumber comes from HyperSync txs/transfers, not LP flows
    // With empty HyperSync, it should be null
    expect(summary.latestBlockNumber).toBeNull();
  });
});
