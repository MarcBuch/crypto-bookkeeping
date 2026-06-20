import { describe, expect, it } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { DashboardPosition } from "../../src/api";
import { Dashboard, EmptyState, ErrorState, LoadingState } from "../../src/App";

const activePosition: DashboardPosition = {
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
    pendingFeesValueInToken1: 0,
    feesValueUsd: 3.23,
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

const closedPosition: DashboardPosition = {
  ...activePosition,
  tokenId: "456",
  status: "closed",
  inRange: false,
  pnl: {
    ...activePosition.pnl!,
    tokenId: "456",
    absolutePnlInToken1: -10,
    absolutePnlPercent: -0.1,
    netVsHodlPercent: -0.04,
  },
};

const closedPositionWithClosedHedge: DashboardPosition = {
  ...closedPosition,
  hedge: {
    coin: "HYPE",
  },
};

function withoutUsdFee(
  position: DashboardPosition,
  tokenId: string,
  feesValueUsd?: number | null,
): DashboardPosition {
  const pnl = { ...position.pnl!, tokenId };

  if (arguments.length === 3) {
    pnl.feesValueUsd = feesValueUsd;
  } else {
    delete pnl.feesValueUsd;
  }

  return {
    ...position,
    tokenId,
    pnl,
  };
}

function renderDashboard(positions: DashboardPosition[]): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Dashboard positions={positions} />
    </QueryClientProvider>,
  );
}

describe("dashboard rendering", () => {
  it("renders loading state", () => {
    const html = renderToStaticMarkup(<LoadingState />);

    expect(html).toContain("Loading LP positions...");
  });

  it("renders actionable error state", () => {
    const html = renderToStaticMarkup(<ErrorState error={new Error("RPC rate limited")} />);

    expect(html).toContain("Could not load LP positions");
    expect(html).toContain("RPC rate limited");
  });

  it("renders empty state", () => {
    const html = renderToStaticMarkup(<EmptyState />);

    expect(html).toContain("No LP positions found");
    expect(html).toContain("Add positions to your wallet/config");
  });

  it("renders mixed active, closed, in-range, and out-of-range positions", () => {
    const html = renderDashboard([activePosition, closedPosition]);

    expect(html).toContain("WHYPE/USDC");
    expect(html).toContain("active");
    expect(html).toContain("closed");
    expect(html).toContain("in range");
    expect(html).toContain("out of range");
    expect(html).toContain("1/2");
  });

  it("formats positive and negative P&L values and decimal percentages", () => {
    const html = renderDashboard([activePosition, closedPosition]);

    expect(html).toContain("25.5 USDC");
    expect(html).toContain("-10 USDC");
    expect(html).toContain("25.5%");
    expect(html).toContain("text-neutral-950");
    expect(html).toContain("text-neutral-500");
  });

  it("prioritizes USD fee income when values are available", () => {
    const html = renderDashboard([activePosition, closedPosition]);

    expect(html).toContain("Fee Income USD");
    expect(html).toContain("$6.46");
    expect(html).toContain("24.69 USDC");
    expect(html).toContain("12.35 USDC");
  });

  it("sums only numeric USD fees across mixed positions", () => {
    const positionWithoutUsdFees = withoutUsdFee(activePosition, "789", null);

    const html = renderDashboard([activePosition, positionWithoutUsdFees]);

    expect(html).toMatch(/Fee Income USD<\/p><span[^>]*><\/span><\/div><p[^>]*>\$3\.23<\/p>/);
    expect(html).toContain("USD unavailable");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("24.69 USDC");
    expect(html).toContain("active");
    expect(html).toContain("in range");
    expect(html).toContain("1 - 2");
  });

  it("shows unavailable portfolio USD fees when every position lacks USD fees", () => {
    const positionWithNullUsdFees = withoutUsdFee(activePosition, "789", null);
    const positionWithMissingUsdFees = withoutUsdFee(closedPosition, "999");

    const html = renderDashboard([positionWithNullUsdFees, positionWithMissingUsdFees]);

    expect(html).toMatch(
      /Fee Income USD<\/p><span[^>]*><\/span><\/div><p[^>]*>USD unavailable<\/p>/,
    );
    expect(html).not.toContain("$0.00");
    expect(html).toContain("24.69 USDC");
    expect(html).toContain("closed");
    expect(html).toContain("out of range");
  });

  it("derives balance USD from token1 price when token0 USD price is missing", () => {
    const positionWithDerivedToken0Usd: DashboardPosition = {
      ...activePosition,
      currentPrice: 2.4,
      currentAmount0: 1.75,
      currentAmount1: 3.2,
      pnl: {
        ...activePosition.pnl!,
        token0UsdPrice: null,
        token1UsdPrice: 2.5,
      },
    };

    const html = renderDashboard([positionWithDerivedToken0Usd]);

    expect(html).toContain("$18.50");
    expect(html).not.toContain("USD unavailable");
  });

  it("derives balance USD from token0 price when token1 USD price is missing", () => {
    const positionWithDerivedToken1Usd: DashboardPosition = {
      ...activePosition,
      currentPrice: 2.4,
      currentAmount0: 1.75,
      currentAmount1: 3.2,
      pnl: {
        ...activePosition.pnl!,
        token0UsdPrice: 6,
        token1UsdPrice: null,
      },
    };

    const html = renderDashboard([positionWithDerivedToken1Usd]);

    expect(html).toContain("$18.50");
    expect(html).not.toContain("USD unavailable");
  });

  it("renders ledger USD fee as primary and token1 fees as secondary context", () => {
    const html = renderDashboard([activePosition]);

    expect(html).toContain("Total Fees");
    expect(html).toMatch(
      /<td class="[^"]*"><div><p class="font-bold[^"]*">\$3\.23<\/p><p class="mt-1 text-xs text-neutral-500">12\.35 USDC<\/p><\/div><\/td>/,
    );
    expect(html).toContain("12.35 USDC");
  });

  it("shows USD unavailable instead of zero for missing USD fees", () => {
    const positionWithoutUsdFees: DashboardPosition = {
      ...activePosition,
      pnl: {
        ...activePosition.pnl!,
        feesValueUsd: null,
      },
    };

    const html = renderDashboard([positionWithoutUsdFees]);

    expect(html).toContain("USD unavailable");
    expect(html).not.toContain("$0.00");
  });

  it("renders numeric zero USD fees as dollars", () => {
    const positionWithZeroUsdFees: DashboardPosition = {
      ...activePosition,
      pnl: {
        ...activePosition.pnl!,
        feesValueUsd: 0,
      },
    };

    const html = renderDashboard([positionWithZeroUsdFees]);

    expect(html).toContain("$0.00");
  });

  it("includes closed hedge P&L in Total MTM P&L when the LP row has hedge metadata", () => {
    const html = renderDashboard([activePosition, closedPositionWithClosedHedge]);

    expect(html).toContain("Total MTM P&amp;L");
    expect(html).toContain("15.5 USDC");
  });
});
