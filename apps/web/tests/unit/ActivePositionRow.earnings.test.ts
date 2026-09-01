import { describe, expect, it } from "bun:test";

import { formatEarningsApr, formatEarningsUsdRate } from "../../src/App";

function buildPosition(pnl: Record<string, unknown>) {
    return {
      currentAmount0: 0,
      currentAmount1: 2000,
      currentPrice: 1,
      pnl: {
      feesValueUsd: 36.5,
      token1Symbol: "USDC",
      token1UsdPrice: 1,
      openedAt: new Date(0).toISOString(),
      ...pnl,
      },
    } as any;
}

describe("ActivePositionRow earnings metrics", () => {
  it("computes fee APR from annualized lifetime fees over current USD valuation", () => {
    const nowMs = 10 * 24 * 60 * 60 * 1000;
    const result = formatEarningsApr(buildPosition({}), nowMs);

    expect(result).toBe("66.61%");
    expect(formatEarningsUsdRate(buildPosition({}), nowMs)).toBe("$3.65/day");
  });

  it("returns n/a when required data is missing or invalid", () => {
    expect(formatEarningsApr({ pnl: undefined } as any, 1000)).toBeNull();
    expect(
      formatEarningsApr(
        { pnl: { feesValueUsd: null, token1Symbol: "USDC", openedAt: new Date(0).toISOString() } } as any,
        1000,
      ),
    ).toBeNull();
    expect(
      formatEarningsApr(
        {
          pnl: {
            feesValueUsd: 10,
            token1Symbol: "USDC",
            token1UsdPrice: 1,
            currentAmount1: 0,
            currentAmount0: 0,
            openedAt: new Date(0).toISOString(),
          },
        } as any,
        1000,
      ),
    ).toBeNull();
  });
});
