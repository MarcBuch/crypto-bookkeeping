/**
 * Adversarial tests for ActivePositionRow ROI computation — fallback behavior.
 *
 * Cluster B: Fallback behavior (no combined path)
 * ================================================
 * Tests cover scenarios where the combined ROI path is NOT taken:
 * 1. No hedge (hedgeData = undefined) — hedgePnlUsd = null → falls back to LP-only
 * 2. Hedge present, token1UsdPrice = null — lpAbsPnlUsd = null → falls back to LP-only
 * 3. pnl = undefined — value = "n/a", no detail, no tooltip
 * 4. Hedge present, token1UsdPrice present — combined path IS taken (control)
 * 5. Hedge = undefined, token1UsdPrice present — combinedAbsUsd = null (hedge is gating)
 * 6. Hedge present (active), token1UsdPrice = null — lpAbsPnlUsd = null suppresses combined
 * 7. All inputs present but lpEntryUsd = 0 — combinedAbsUsd non-null but combinedRoiPct = null
 *
 * Testing approach
 * ================
 * We test the pure computation logic of the ROI values:
 * - hedgePnlUsd calculation
 * - lpAbsPnlUsd calculation
 * - lpEntryUsd calculation
 * - combinedAbsUsd calculation
 * - combinedRoiPct calculation
 * - DarkStat output (value, detail, tooltip)
 *
 * No React rendering needed — we compute the values directly and verify the logic.
 */

import { describe, expect, it } from "bun:test";

import type { DashboardPosition, HedgeView } from "../../src/api";

// ============================================================================
// Test Fixtures
// ============================================================================

const basePosition: DashboardPosition = {
  tokenId: "123",
  token0: { address: "0x0", symbol: "WHYPE", decimals: 18 },
  token1: { address: "0x1", symbol: "USDC", decimals: 6 },
  fee: 3000,
  feePercent: 0.3,
  tickLower: -10,
  tickUpper: 10,
  priceLower: 1,
  priceUpper: 2,
  currentPrice: 1.5,
  liquidity: "1000",
  status: "active",
  inRange: true,
  currentAmount0: 1.2345,
  currentAmount1: 200.12,
  pnl: {
    tokenId: "123",
    pair: "WHYPE/USDC",
    token0Symbol: "WHYPE",
    token1Symbol: "USDC",
    status: "active",
    entryPrice: 1,
    exitPrice: 1.5,
    priceChangePercent: 0.5,
    entryAmount0: 1,
    entryAmount1: 100,
    exitAmount0: 1,
    exitAmount1: 120,
    feesCollected0: 0.1,
    feesCollected1: 2,
    feesCollected0Usd: 1.23,
    feesCollected1Usd: 2,
    feesValueInToken1: 12.345,
    feesValueUsd: 3.23,
    pendingFeesValueInToken1: 0.5,
    pendingFeesValueUsd: 0.1,
    token0UsdPrice: 12.3,
    token1UsdPrice: 1,
    usdPriceSource: "coingecko",
    entryValueInToken1: 100,
    exitValueInToken1: 125,
    holdValueInToken1: 120,
    absolutePnlInToken1: 25.5,
    absolutePnlPercent: 0.255,
    divergenceLossPercent: -0.01,
    opportunityCostInToken1: 2,
    netVsHodlPercent: 0.05,
    priceLower: 1,
    priceUpper: 2,
  },
};

const baseHedgeData: HedgeView = {
  tokenId: "123",
  coin: "HYPE",
  szi: "-5.5",
  entryPx: 10.5,
  markPx: 11.2,
  unrealizedPnl: 350,
  fundingEarned: 25.5,
  liquidationPx: 8.5,
  leverage: { type: "cross", value: 1 },
  status: "active",
};

// ============================================================================
// Helper: Compute ROI values (mirrors ActivePositionRow logic)
// ============================================================================

interface RoiComputationResult {
  hedgePnlUsd: number | null;
  lpAbsPnlUsd: number | null;
  lpEntryUsd: number | null;
  combinedAbsUsd: number | null;
  combinedRoiPct: number | null;
  roiValue: string; // "n/a" or formatted percent or fallback
  roiDetail: string | undefined;
  roiTooltip: string | undefined;
}

function computeRoiValues(
  position: DashboardPosition | undefined,
  hedgeData: HedgeView | undefined
): RoiComputationResult {
  const pnl = position?.pnl;

  // Hedge-adjusted ROI
  const hedgePnlUsd = hedgeData
    ? hedgeData.status === "closed"
      ? hedgeData.realizedPnl != null
        ? hedgeData.realizedPnl + hedgeData.fundingEarned
        : null
      : hedgeData.unrealizedPnl + hedgeData.fundingEarned
    : null;

  const lpAbsPnlUsd = pnl?.token1UsdPrice != null
    ? pnl.absolutePnlInToken1 * pnl.token1UsdPrice
    : null;
  const lpEntryUsd = pnl?.token1UsdPrice != null
    ? pnl.entryValueInToken1 * pnl.token1UsdPrice
    : null;

  const combinedAbsUsd =
    lpAbsPnlUsd != null && hedgePnlUsd != null ? lpAbsPnlUsd + hedgePnlUsd : null;
  const combinedRoiPct =
    combinedAbsUsd != null && lpEntryUsd != null && lpEntryUsd > 0
      ? combinedAbsUsd / lpEntryUsd
      : null;

  // DarkStat output logic
  const roiValue = pnl
    ? formatPercent(combinedRoiPct ?? pnl.absolutePnlPercent)
    : "n/a";

  const roiDetail = pnl
    ? combinedAbsUsd != null
      ? `${formatUsd(combinedAbsUsd)} (LP ${formatUsd(lpAbsPnlUsd!)} · hedge ${formatUsd(hedgePnlUsd!)})`
      : pnl.token1UsdPrice != null
        ? formatUsd(pnl.absolutePnlInToken1 * pnl.token1UsdPrice)
        : `${formatNumber(pnl.absolutePnlInToken1)} ${pnl.token1Symbol}`
    : undefined;

  const roiTooltip = pnl
    ? combinedRoiPct != null
      ? "Gain/loss vs entry value. Includes all fees earned (collected + pending) + hedge P&L."
      : "Gain/loss vs entry value. Includes all fees earned (collected + pending)."
    : undefined;

  return {
    hedgePnlUsd,
    lpAbsPnlUsd,
    lpEntryUsd,
    combinedAbsUsd,
    combinedRoiPct,
    roiValue,
    roiDetail,
    roiTooltip,
  };
}

// ============================================================================
// Formatting helpers (mirrors App.tsx)
// ============================================================================

function formatPercent(value: number | null): string {
  if (value == null) return "n/a";
  return `${(value * 100).toFixed(2)}%`;
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

// ============================================================================
// Tests: Cluster B — Fallback behavior
// ============================================================================

describe("ActivePositionRow ROI — fallback behavior", () => {
  // ========================================================================
  // Test 1: No hedge (hedgeData = undefined)
  // ========================================================================

  describe("Test 1: No hedge (hedgeData = undefined)", () => {
    it("hedgePnlUsd = null when hedgeData is undefined", () => {
      const result = computeRoiValues(basePosition, undefined);

      expect(result.hedgePnlUsd).toBeNull();
    });

    it("combinedAbsUsd = null when hedgeData is undefined (hedge is gating)", () => {
      const result = computeRoiValues(basePosition, undefined);

      expect(result.combinedAbsUsd).toBeNull();
    });

    it("combinedRoiPct = null when hedgeData is undefined", () => {
      const result = computeRoiValues(basePosition, undefined);

      expect(result.combinedRoiPct).toBeNull();
    });

    it("ROI value falls back to LP-only absolutePnlPercent", () => {
      const result = computeRoiValues(basePosition, undefined);

      // Should use pnl.absolutePnlPercent (0.255 = 25.5%)
      expect(result.roiValue).toBe("25.50%");
    });

    it("ROI detail shows LP-only USD value", () => {
      const result = computeRoiValues(basePosition, undefined);

      // lpAbsPnlUsd = 25.5 * 1 = 25.5
      expect(result.roiDetail).toContain("$25.50");
      expect(result.roiDetail).not.toContain("hedge");
    });

    it("ROI tooltip is LP-only (no hedge mention)", () => {
      const result = computeRoiValues(basePosition, undefined);

      expect(result.roiTooltip).toContain("Includes all fees earned");
      expect(result.roiTooltip).not.toContain("hedge P&L");
    });
  });

  // ========================================================================
  // Test 2: Hedge present, token1UsdPrice = null
  // ========================================================================

  describe("Test 2: Hedge present, token1UsdPrice = null", () => {
    it("lpAbsPnlUsd = null when token1UsdPrice is null", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.lpAbsPnlUsd).toBeNull();
    });

    it("combinedAbsUsd = null when lpAbsPnlUsd is null (even if hedgePnlUsd is non-null)", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.hedgePnlUsd).not.toBeNull(); // Hedge is present
      expect(result.lpAbsPnlUsd).toBeNull(); // But LP USD is null
      expect(result.combinedAbsUsd).toBeNull(); // So combined is null
    });

    it("ROI value falls back to LP-only absolutePnlPercent", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.roiValue).toBe("25.50%");
    });

    it("ROI detail shows LP-only token value (not USD)", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      // Should show token value, not USD
      expect(result.roiDetail).toContain("25.50 USDC");
      expect(result.roiDetail).not.toContain("$");
      expect(result.roiDetail).not.toContain("hedge");
    });

    it("ROI tooltip is LP-only (no hedge mention)", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.roiTooltip).not.toContain("hedge P&L");
    });
  });

  // ========================================================================
  // Test 3: pnl = undefined
  // ========================================================================

  describe("Test 3: pnl = undefined", () => {
    it("ROI value = 'n/a' when pnl is undefined", () => {
      const positionWithoutPnl: DashboardPosition = {
        ...basePosition,
        pnl: undefined,
      };

      const result = computeRoiValues(positionWithoutPnl, baseHedgeData);

      expect(result.roiValue).toBe("n/a");
    });

    it("ROI detail = undefined when pnl is undefined", () => {
      const positionWithoutPnl: DashboardPosition = {
        ...basePosition,
        pnl: undefined,
      };

      const result = computeRoiValues(positionWithoutPnl, baseHedgeData);

      expect(result.roiDetail).toBeUndefined();
    });

    it("ROI tooltip = undefined when pnl is undefined", () => {
      const positionWithoutPnl: DashboardPosition = {
        ...basePosition,
        pnl: undefined,
      };

      const result = computeRoiValues(positionWithoutPnl, baseHedgeData);

      expect(result.roiTooltip).toBeUndefined();
    });

    it("does not crash when position is undefined", () => {
      const result = computeRoiValues(undefined, baseHedgeData);

      expect(result.roiValue).toBe("n/a");
      expect(result.roiDetail).toBeUndefined();
      expect(result.roiTooltip).toBeUndefined();
    });
  });

  // ========================================================================
  // Test 4: Hedge present, token1UsdPrice present (control — combined path)
  // ========================================================================

  describe("Test 4: Hedge present, token1UsdPrice present (combined path)", () => {
    it("hedgePnlUsd is non-null when hedge is active", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      // hedgePnlUsd = 350 + 25.5 = 375.5
      expect(result.hedgePnlUsd).toBe(375.5);
    });

    it("lpAbsPnlUsd is non-null when token1UsdPrice is present", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      // lpAbsPnlUsd = 25.5 * 1 = 25.5
      expect(result.lpAbsPnlUsd).toBe(25.5);
    });

    it("combinedAbsUsd is non-null when both lpAbsPnlUsd and hedgePnlUsd are non-null", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      // combinedAbsUsd = 25.5 + 375.5 = 401
      expect(result.combinedAbsUsd).toBe(401);
    });

    it("combinedRoiPct is non-null when combinedAbsUsd and lpEntryUsd are non-null and lpEntryUsd > 0", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      // combinedRoiPct = 401 / 100 = 4.01
      expect(result.combinedRoiPct).toBe(4.01);
    });

    it("ROI value uses combinedRoiPct (not LP-only)", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      // combinedRoiPct = 4.01 = 401%
      expect(result.roiValue).toBe("401.00%");
      expect(result.roiValue).not.toBe("25.50%"); // Not LP-only
    });

    it("ROI detail shows combined breakdown", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      expect(result.roiDetail).toContain("$401.00");
      expect(result.roiDetail).toContain("LP $25.50");
      expect(result.roiDetail).toContain("hedge $375.50");
    });

    it("ROI tooltip mentions hedge P&L", () => {
      const result = computeRoiValues(basePosition, baseHedgeData);

      expect(result.roiTooltip).toContain("hedge P&L");
    });
  });

  // ========================================================================
  // Test 5: Hedge = undefined, token1UsdPrice present
  // ========================================================================

  describe("Test 5: Hedge = undefined, token1UsdPrice present", () => {
    it("combinedAbsUsd = null when hedgeData is undefined (hedge is gating factor)", () => {
      const result = computeRoiValues(basePosition, undefined);

      // Even though token1UsdPrice is present and lpAbsPnlUsd is non-null,
      // hedgePnlUsd is null, so combinedAbsUsd is null
      expect(result.lpAbsPnlUsd).not.toBeNull();
      expect(result.hedgePnlUsd).toBeNull();
      expect(result.combinedAbsUsd).toBeNull();
    });

    it("ROI falls back to LP-only even with USD price available", () => {
      const result = computeRoiValues(basePosition, undefined);

      expect(result.roiValue).toBe("25.50%");
      expect(result.roiDetail).toContain("$25.50");
      expect(result.roiDetail).not.toContain("hedge");
    });
  });

  // ========================================================================
  // Test 6: Hedge present (active), token1UsdPrice = null
  // ========================================================================

  describe("Test 6: Hedge present (active), token1UsdPrice = null", () => {
    it("lpAbsPnlUsd = null suppresses combined path even with active hedge", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.hedgePnlUsd).not.toBeNull(); // Hedge is active
      expect(result.lpAbsPnlUsd).toBeNull(); // But LP USD is null
      expect(result.combinedAbsUsd).toBeNull(); // So combined is suppressed
    });

    it("ROI value is LP-only percent (not combined)", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.roiValue).toBe("25.50%");
    });

    it("ROI detail shows token value (not combined USD)", () => {
      const positionWithNullUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: null,
        },
      };

      const result = computeRoiValues(positionWithNullUsdPrice, baseHedgeData);

      expect(result.roiDetail).toContain("25.50 USDC");
      expect(result.roiDetail).not.toContain("hedge");
    });
  });

  // ========================================================================
  // Test 7: All inputs present but lpEntryUsd = 0
  // ========================================================================

  describe("Test 7: All inputs present but lpEntryUsd = 0", () => {
    it("combinedAbsUsd is non-null even when lpEntryUsd = 0", () => {
      const positionWithZeroEntry: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          entryValueInToken1: 0,
        },
      };

      const result = computeRoiValues(positionWithZeroEntry, baseHedgeData);

      // combinedAbsUsd = lpAbsPnlUsd + hedgePnlUsd = 25.5 + 375.5 = 401
      // (lpAbsPnlUsd is still 25.5 because absolutePnlInToken1 = 25.5)
      expect(result.combinedAbsUsd).toBe(401);
    });

    it("combinedRoiPct = null when lpEntryUsd = 0 (division by zero guard)", () => {
      const positionWithZeroEntry: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          entryValueInToken1: 0,
        },
      };

      const result = computeRoiValues(positionWithZeroEntry, baseHedgeData);

      // combinedRoiPct = null because lpEntryUsd = 0 (guard against division by zero)
      expect(result.combinedRoiPct).toBeNull();
    });

    it("ROI value falls back to LP-only absolutePnlPercent when combinedRoiPct = null", () => {
      const positionWithZeroEntry: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          entryValueInToken1: 0,
        },
      };

      const result = computeRoiValues(positionWithZeroEntry, baseHedgeData);

      // Should use pnl.absolutePnlPercent (0.255 = 25.5%)
      expect(result.roiValue).toBe("25.50%");
    });

    it("ROI detail still shows combined USD breakdown (combinedAbsUsd is non-null)", () => {
      const positionWithZeroEntry: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          entryValueInToken1: 0,
        },
      };

      const result = computeRoiValues(positionWithZeroEntry, baseHedgeData);

      // combinedAbsUsd is non-null (401), so detail shows combined breakdown
      expect(result.roiDetail).toContain("$401.00");
      expect(result.roiDetail).toContain("LP $25.50");
      expect(result.roiDetail).toContain("hedge $375.50");
    });

    it("ROI tooltip is LP-only (combinedRoiPct = null, so no hedge mention)", () => {
      const positionWithZeroEntry: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          entryValueInToken1: 0,
        },
      };

      const result = computeRoiValues(positionWithZeroEntry, baseHedgeData);

      // combinedRoiPct = null, so tooltip is LP-only
      expect(result.roiTooltip).not.toContain("hedge P&L");
    });
  });

  // ========================================================================
  // Additional edge cases
  // ========================================================================

  describe("Additional edge cases", () => {
    it("handles negative lpAbsPnlUsd correctly", () => {
      const positionWithLoss: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          absolutePnlInToken1: -10,
        },
      };

      const result = computeRoiValues(positionWithLoss, baseHedgeData);

      // lpAbsPnlUsd = -10 * 1 = -10
      expect(result.lpAbsPnlUsd).toBe(-10);
      // combinedAbsUsd = -10 + 375.5 = 365.5
      expect(result.combinedAbsUsd).toBe(365.5);
    });

    it("handles closed hedge with realizedPnl = null (suppresses combined)", () => {
      const closedHedgeWithoutRealizedPnl: HedgeView = {
        ...baseHedgeData,
        status: "closed",
        realizedPnl: null,
      };

      const result = computeRoiValues(basePosition, closedHedgeWithoutRealizedPnl);

      // hedgePnlUsd = null (closed hedge with null realizedPnl)
      expect(result.hedgePnlUsd).toBeNull();
      // combinedAbsUsd = null (hedgePnlUsd is null)
      expect(result.combinedAbsUsd).toBeNull();
      // Falls back to LP-only
      expect(result.roiValue).toBe("25.50%");
    });

    it("handles closed hedge with realizedPnl present (uses combined)", () => {
      const closedHedgeWithRealizedPnl: HedgeView = {
        ...baseHedgeData,
        status: "closed",
        realizedPnl: 200,
      };

      const result = computeRoiValues(basePosition, closedHedgeWithRealizedPnl);

      // hedgePnlUsd = 200 + 25.5 = 225.5
      expect(result.hedgePnlUsd).toBe(225.5);
      // combinedAbsUsd = 25.5 + 225.5 = 251
      expect(result.combinedAbsUsd).toBe(251);
      // combinedRoiPct = 251 / 100 = 2.51
      expect(result.combinedRoiPct).toBe(2.51);
      // ROI value uses combined
      expect(result.roiValue).toBe("251.00%");
    });

    it("handles very small token1UsdPrice (e.g., 0.001)", () => {
      const positionWithSmallUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: 0.001,
        },
      };

      const result = computeRoiValues(positionWithSmallUsdPrice, baseHedgeData);

      // lpAbsPnlUsd = 25.5 * 0.001 = 0.0255
      expect(result.lpAbsPnlUsd).toBeCloseTo(0.0255, 5);
      // lpEntryUsd = 100 * 0.001 = 0.1
      expect(result.lpEntryUsd).toBeCloseTo(0.1, 5);
      // combinedAbsUsd = 0.0255 + 375.5 = 375.5255
      expect(result.combinedAbsUsd).toBeCloseTo(375.5255, 4);
    });

    it("handles large token1UsdPrice (e.g., 10000)", () => {
      const positionWithLargeUsdPrice: DashboardPosition = {
        ...basePosition,
        pnl: {
          ...basePosition.pnl!,
          token1UsdPrice: 10000,
        },
      };

      const result = computeRoiValues(positionWithLargeUsdPrice, baseHedgeData);

      // lpAbsPnlUsd = 25.5 * 10000 = 255000
      expect(result.lpAbsPnlUsd).toBe(255000);
      // lpEntryUsd = 100 * 10000 = 1000000
      expect(result.lpEntryUsd).toBe(1000000);
      // combinedAbsUsd = 255000 + 375.5 = 255375.5
      expect(result.combinedAbsUsd).toBe(255375.5);
    });
  });
});
