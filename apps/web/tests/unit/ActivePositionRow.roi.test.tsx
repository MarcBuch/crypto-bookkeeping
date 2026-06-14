/**
 * Adversarial tests for ActivePositionRow combined ROI math.
 *
 * Cluster A: Combined ROI math
 * ============================
 * Tests cover the pure computation logic for hedge-adjusted ROI:
 * - hedgePnlUsd calculation (active vs closed hedge, realizedPnl handling)
 * - lpAbsPnlUsd and lpEntryUsd calculation
 * - combinedAbsUsd and combinedRoiPct calculation
 * - Edge cases: null values, zero values, division-by-zero guards
 * - Large values and precision
 * - Negative funding (funding paid, not earned)
 *
 * Testing approach
 * ================
 * We use a helper function that simulates the exact computation from
 * ActivePositionRow lines 301–324. The helper returns all intermediate
 * values so we can test the logic at each step.
 *
 * No React rendering needed — pure computation logic only.
 */

import { describe, expect, it } from "bun:test";

// ============================================================================
// Helper: Simulate combined ROI computation
// ============================================================================

interface HedgeData {
  status: "active" | "closed";
  unrealizedPnl: number;
  realizedPnl?: number | null;
  fundingEarned: number;
}

interface PnlData {
  absolutePnlInToken1: number;
  token1UsdPrice: number | null;
  entryValueInToken1: number;
}

interface ComputedRoi {
  hedgePnlUsd: number | null;
  lpAbsPnlUsd: number | null;
  lpEntryUsd: number | null;
  combinedAbsUsd: number | null;
  combinedRoiPct: number | null;
}

/**
 * Simulates the exact computation from ActivePositionRow lines 301–324.
 * Returns all intermediate values for testing.
 */
function computeCombinedRoi(
  hedgeData: HedgeData | undefined,
  pnl: PnlData | undefined,
): ComputedRoi {
  // Hedge-adjusted ROI
  // For closed hedges, suppress combined ROI when realizedPnl is unknown (null/undefined)
  // rather than silently treating unknown P&L as zero.
  const hedgePnlUsd = hedgeData
    ? hedgeData.status === "closed"
      ? hedgeData.realizedPnl != null
        ? hedgeData.realizedPnl + hedgeData.fundingEarned
        : null
      : hedgeData.unrealizedPnl + hedgeData.fundingEarned
    : null;

  const lpAbsPnlUsd =
    pnl?.token1UsdPrice != null ? pnl.absolutePnlInToken1 * pnl.token1UsdPrice : null;
  const lpEntryUsd =
    pnl?.token1UsdPrice != null ? pnl.entryValueInToken1 * pnl.token1UsdPrice : null;

  const combinedAbsUsd =
    lpAbsPnlUsd != null && hedgePnlUsd != null ? lpAbsPnlUsd + hedgePnlUsd : null;
  const combinedRoiPct =
    combinedAbsUsd != null && lpEntryUsd != null && lpEntryUsd > 0
      ? combinedAbsUsd / lpEntryUsd
      : null;

  return {
    hedgePnlUsd,
    lpAbsPnlUsd,
    lpEntryUsd,
    combinedAbsUsd,
    combinedRoiPct,
  };
}

// ============================================================================
// Test Fixtures
// ============================================================================

// ============================================================================
// Tests: Cluster A — Combined ROI math
// ============================================================================

describe("ActivePositionRow combined ROI math — Cluster A", () => {
  // =========================================================================
  // Test 1: LP profit + active hedge profit — both positive, combined > 0
  // =========================================================================
  it("1. LP profit + active hedge profit — both positive, combined > 0", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 25.5,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 350,
      fundingEarned: 25.5,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 25.5 * 1 = 25.5
    expect(result.lpAbsPnlUsd).toBe(25.5);
    // Hedge: 350 + 25.5 = 375.5
    expect(result.hedgePnlUsd).toBe(375.5);
    // Combined: 25.5 + 375.5 = 401
    expect(result.combinedAbsUsd).toBe(401);
    // ROI: 401 / 100 = 4.01 (401%)
    expect(result.combinedRoiPct).toBe(4.01);
  });

  // =========================================================================
  // Test 2: LP profit + active hedge loss — hedge loss but combined still positive
  // =========================================================================
  it("2. LP profit + active hedge loss — hedge loss but combined still positive", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 100,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: -50,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 100 * 1 = 100
    expect(result.lpAbsPnlUsd).toBe(100);
    // Hedge: -50 + 10 = -40
    expect(result.hedgePnlUsd).toBe(-40);
    // Combined: 100 - 40 = 60
    expect(result.combinedAbsUsd).toBe(60);
    // ROI: 60 / 100 = 0.6 (60%)
    expect(result.combinedRoiPct).toBe(0.6);
  });

  // =========================================================================
  // Test 3: LP profit + active hedge loss (combined negative) — hedge dominates
  // =========================================================================
  it("3. LP profit + active hedge loss (combined negative) — hedge dominates, combined < 0", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: -200,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: -200 + 10 = -190
    expect(result.hedgePnlUsd).toBe(-190);
    // Combined: 50 - 190 = -140
    expect(result.combinedAbsUsd).toBe(-140);
    // ROI: -140 / 100 = -1.4 (-140%)
    expect(result.combinedRoiPct).toBe(-1.4);
  });

  // =========================================================================
  // Test 4: LP loss + active hedge profit (hedge covers) — combined positive
  // =========================================================================
  it("4. LP loss + active hedge profit (hedge covers) — combined positive", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: -30,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 20,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: -30 * 1 = -30
    expect(result.lpAbsPnlUsd).toBe(-30);
    // Hedge: 100 + 20 = 120
    expect(result.hedgePnlUsd).toBe(120);
    // Combined: -30 + 120 = 90
    expect(result.combinedAbsUsd).toBe(90);
    // ROI: 90 / 100 = 0.9 (90%)
    expect(result.combinedRoiPct).toBe(0.9);
  });

  // =========================================================================
  // Test 5: LP loss + active hedge loss — combined deeply negative
  // =========================================================================
  it("5. LP loss + active hedge loss — combined deeply negative", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: -50,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: -100,
      fundingEarned: 5,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: -50 * 1 = -50
    expect(result.lpAbsPnlUsd).toBe(-50);
    // Hedge: -100 + 5 = -95
    expect(result.hedgePnlUsd).toBe(-95);
    // Combined: -50 - 95 = -145
    expect(result.combinedAbsUsd).toBe(-145);
    // ROI: -145 / 100 = -1.45 (-145%)
    expect(result.combinedRoiPct).toBe(-1.45);
  });

  // =========================================================================
  // Test 6: Closed hedge with realizedPnl set — uses realizedPnl + fundingEarned
  // =========================================================================
  it("6. Closed hedge with realizedPnl set — uses realizedPnl + fundingEarned", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 20,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "closed",
      unrealizedPnl: 0,
      realizedPnl: 200,
      fundingEarned: 30,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 20 * 1 = 20
    expect(result.lpAbsPnlUsd).toBe(20);
    // Hedge: 200 + 30 = 230 (uses realizedPnl, not unrealizedPnl)
    expect(result.hedgePnlUsd).toBe(230);
    // Combined: 20 + 230 = 250
    expect(result.combinedAbsUsd).toBe(250);
    // ROI: 250 / 100 = 2.5 (250%)
    expect(result.combinedRoiPct).toBe(2.5);
  });

  // =========================================================================
  // Test 7: Closed hedge with realizedPnl = null — hedgePnlUsd = null → suppressed
  // =========================================================================
  it("7. Closed hedge with realizedPnl = null — hedgePnlUsd = null → combinedAbsUsd = null (suppressed)", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 20,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "closed",
      unrealizedPnl: 0,
      realizedPnl: null,
      fundingEarned: 30,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 20 * 1 = 20
    expect(result.lpAbsPnlUsd).toBe(20);
    // Hedge: null (realizedPnl is null, so hedgePnlUsd is null)
    expect(result.hedgePnlUsd).toBeNull();
    // Combined: null (because hedgePnlUsd is null, not treated as zero)
    expect(result.combinedAbsUsd).toBeNull();
    // ROI: null (because combinedAbsUsd is null)
    expect(result.combinedRoiPct).toBeNull();
  });

  // =========================================================================
  // Test 8: Closed hedge with realizedPnl = 0 — zero is valid, combinedAbsUsd computed
  // =========================================================================
  it("8. Closed hedge with realizedPnl = 0 — zero is valid value, combinedAbsUsd should be computed", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 20,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "closed",
      unrealizedPnl: 0,
      realizedPnl: 0,
      fundingEarned: 30,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 20 * 1 = 20
    expect(result.lpAbsPnlUsd).toBe(20);
    // Hedge: 0 + 30 = 30 (zero is a valid value, not suppressed)
    expect(result.hedgePnlUsd).toBe(30);
    // Combined: 20 + 30 = 50
    expect(result.combinedAbsUsd).toBe(50);
    // ROI: 50 / 100 = 0.5 (50%)
    expect(result.combinedRoiPct).toBe(0.5);
  });

  // =========================================================================
  // Test 9: Zero combined P&L (LP cancels hedge) — combinedAbsUsd = 0, combinedRoiPct = 0
  // =========================================================================
  it("9. Zero combined P&L (LP cancels hedge) — combinedAbsUsd = 0, combinedRoiPct = 0", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: -50,
      fundingEarned: 0,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: -50 + 0 = -50
    expect(result.hedgePnlUsd).toBe(-50);
    // Combined: 50 - 50 = 0
    expect(result.combinedAbsUsd).toBe(0);
    // ROI: 0 / 100 = 0
    expect(result.combinedRoiPct).toBe(0);
  });

  // =========================================================================
  // Test 10: lpEntryUsd = 0 — combinedRoiPct = null (division-by-zero guard)
  // =========================================================================
  it("10. lpEntryUsd = 0 — combinedRoiPct = null (division-by-zero guard)", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 0, // Entry value is zero
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: 100 + 10 = 110
    expect(result.hedgePnlUsd).toBe(110);
    // Combined: 50 + 110 = 160
    expect(result.combinedAbsUsd).toBe(160);
    // lpEntryUsd: 0 * 1 = 0
    expect(result.lpEntryUsd).toBe(0);
    // ROI: null (because lpEntryUsd is 0, guard prevents division by zero)
    expect(result.combinedRoiPct).toBeNull();
  });

  // =========================================================================
  // Test 11: Large values — LP +$50k, hedge +$20k → combinedRoiPct correct to 4dp
  // =========================================================================
  it("11. Large values — LP +$50k, hedge +$20k → combinedRoiPct correct to 4dp", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50000,
      token1UsdPrice: 1,
      entryValueInToken1: 100000,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 15000,
      fundingEarned: 5000,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50000 * 1 = 50000
    expect(result.lpAbsPnlUsd).toBe(50000);
    // Hedge: 15000 + 5000 = 20000
    expect(result.hedgePnlUsd).toBe(20000);
    // Combined: 50000 + 20000 = 70000
    expect(result.combinedAbsUsd).toBe(70000);
    // ROI: 70000 / 100000 = 0.7 (70%)
    expect(result.combinedRoiPct).toBe(0.7);
  });

  // =========================================================================
  // Test 12: Negative funding earned (funding paid, not earned) — hedge P&L reduced
  // =========================================================================
  it("12. Negative funding earned (funding paid, not earned) — hedge P&L reduced accordingly", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 100,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 200,
      fundingEarned: -50, // Negative: funding paid, not earned
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 100 * 1 = 100
    expect(result.lpAbsPnlUsd).toBe(100);
    // Hedge: 200 - 50 = 150 (funding paid reduces P&L)
    expect(result.hedgePnlUsd).toBe(150);
    // Combined: 100 + 150 = 250
    expect(result.combinedAbsUsd).toBe(250);
    // ROI: 250 / 100 = 2.5 (250%)
    expect(result.combinedRoiPct).toBe(2.5);
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================

  it("no hedge data — hedgePnlUsd = null → combinedAbsUsd = null", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const result = computeCombinedRoi(undefined, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: null (no hedge data)
    expect(result.hedgePnlUsd).toBeNull();
    // Combined: null (because hedgePnlUsd is null)
    expect(result.combinedAbsUsd).toBeNull();
    // ROI: null (because combinedAbsUsd is null)
    expect(result.combinedRoiPct).toBeNull();
  });

  it("no pnl data — lpAbsPnlUsd = null → combinedAbsUsd = null", () => {
    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, undefined);

    // LP: null (no pnl data)
    expect(result.lpAbsPnlUsd).toBeNull();
    // Hedge: 100 + 10 = 110
    expect(result.hedgePnlUsd).toBe(110);
    // Combined: null (because lpAbsPnlUsd is null)
    expect(result.combinedAbsUsd).toBeNull();
    // ROI: null (because combinedAbsUsd is null)
    expect(result.combinedRoiPct).toBeNull();
  });

  it("token1UsdPrice = null — lpAbsPnlUsd = null → combinedAbsUsd = null", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: null, // No USD price
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: null (token1UsdPrice is null)
    expect(result.lpAbsPnlUsd).toBeNull();
    // Hedge: 100 + 10 = 110
    expect(result.hedgePnlUsd).toBe(110);
    // Combined: null (because lpAbsPnlUsd is null)
    expect(result.combinedAbsUsd).toBeNull();
    // ROI: null (because combinedAbsUsd is null)
    expect(result.combinedRoiPct).toBeNull();
  });

  it("active hedge with zero unrealizedPnl — only funding contributes", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 100,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 0,
      fundingEarned: 30,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: 0 + 30 = 30 (only funding, no price move)
    expect(result.hedgePnlUsd).toBe(30);
    // Combined: 50 + 30 = 80
    expect(result.combinedAbsUsd).toBe(80);
    // ROI: 80 / 100 = 0.8 (80%)
    expect(result.combinedRoiPct).toBe(0.8);
  });

  it("precision test — fractional values maintain precision", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 12.3456,
      token1UsdPrice: 0.5678,
      entryValueInToken1: 99.9999,
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 45.6789,
      fundingEarned: 12.3456,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 12.3456 * 0.5678 ≈ 7.0127...
    const expectedLpAbsPnl = 12.3456 * 0.5678;
    expect(result.lpAbsPnlUsd).toBeCloseTo(expectedLpAbsPnl, 4);

    // Hedge: 45.6789 + 12.3456 = 58.0245
    expect(result.hedgePnlUsd).toBeCloseTo(58.0245, 4);

    // Combined: expectedLpAbsPnl + 58.0245
    const expectedCombined = expectedLpAbsPnl + 58.0245;
    expect(result.combinedAbsUsd).toBeCloseTo(expectedCombined, 4);

    // lpEntryUsd: 99.9999 * 0.5678 ≈ 56.7799...
    const expectedLpEntry = 99.9999 * 0.5678;
    expect(result.lpEntryUsd).toBeCloseTo(expectedLpEntry, 4);

    // ROI: expectedCombined / expectedLpEntry
    const expectedRoi = expectedCombined / expectedLpEntry;
    expect(result.combinedRoiPct).toBeCloseTo(expectedRoi, 4);
  });

  it("negative entry value — lpEntryUsd negative, ROI suppressed (guard: lpEntryUsd > 0)", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: -100, // Unusual: negative entry value
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: 100 + 10 = 110
    expect(result.hedgePnlUsd).toBe(110);
    // Combined: 50 + 110 = 160
    expect(result.combinedAbsUsd).toBe(160);
    // lpEntryUsd: -100 * 1 = -100
    expect(result.lpEntryUsd).toBe(-100);
    // ROI: null (because lpEntryUsd is not > 0, guard prevents division)
    expect(result.combinedRoiPct).toBeNull();
  });

  it("very small positive lpEntryUsd — ROI computed correctly (not suppressed)", () => {
    const pnl: PnlData = {
      absolutePnlInToken1: 50,
      token1UsdPrice: 1,
      entryValueInToken1: 0.0001, // Very small but positive
    };

    const hedgeData: HedgeData = {
      status: "active",
      unrealizedPnl: 100,
      fundingEarned: 10,
    };

    const result = computeCombinedRoi(hedgeData, pnl);

    // LP: 50 * 1 = 50
    expect(result.lpAbsPnlUsd).toBe(50);
    // Hedge: 100 + 10 = 110
    expect(result.hedgePnlUsd).toBe(110);
    // Combined: 50 + 110 = 160
    expect(result.combinedAbsUsd).toBe(160);
    // lpEntryUsd: 0.0001 * 1 = 0.0001
    expect(result.lpEntryUsd).toBe(0.0001);
    // ROI: 160 / 0.0001 = 1600000 (very large ROI)
    expect(result.combinedRoiPct).toBe(1600000);
  });
});
