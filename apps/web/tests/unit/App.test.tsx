import { describe, expect, it } from "bun:test";

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
    const html = renderToStaticMarkup(<Dashboard positions={[activePosition, closedPosition]} />);

    expect(html).toContain("WHYPE/USDC");
    expect(html).toContain("active");
    expect(html).toContain("closed");
    expect(html).toContain("in range");
    expect(html).toContain("out of range");
    expect(html).toContain("1/2");
  });

  it("formats positive and negative P&L values and decimal percentages", () => {
    const html = renderToStaticMarkup(<Dashboard positions={[activePosition, closedPosition]} />);

    expect(html).toContain("25.5 USDC");
    expect(html).toContain("-10 USDC");
    expect(html).toContain("25.5%");
    expect(html).toContain("text-neutral-950");
    expect(html).toContain("text-neutral-500");
  });

  it("prioritizes USD fee income when values are available", () => {
    const html = renderToStaticMarkup(<Dashboard positions={[activePosition, closedPosition]} />);

    expect(html).toContain("Fee Income USD");
    expect(html).toContain("$6.46");
    expect(html).toContain("Net P&amp;L 15.5 USDC");
    expect(html).toContain("Fees 12.35 USDC");
  });

  it("sums only numeric USD fees across mixed positions", () => {
    const positionWithoutUsdFees = withoutUsdFee(activePosition, "789", null);

    const html = renderToStaticMarkup(
      <Dashboard positions={[activePosition, positionWithoutUsdFees]} />,
    );

    expect(html).toMatch(/Fee Income USD<\/p><span[^>]*><\/span><\/div><p[^>]*>\$3\.23<\/p>/);
    expect(html).toContain("USD unavailable");
    expect(html).not.toContain("$0.00");
    expect(html).toContain("Net P&amp;L 51 USDC");
    expect(html).toContain("active");
    expect(html).toContain("in range");
    expect(html).toContain("1 - 2");
  });

  it("shows unavailable portfolio USD fees when every position lacks USD fees", () => {
    const positionWithNullUsdFees = withoutUsdFee(activePosition, "789", null);
    const positionWithMissingUsdFees = withoutUsdFee(closedPosition, "999");

    const html = renderToStaticMarkup(
      <Dashboard positions={[positionWithNullUsdFees, positionWithMissingUsdFees]} />,
    );

    expect(html).toMatch(
      /Fee Income USD<\/p><span[^>]*><\/span><\/div><p[^>]*>USD unavailable<\/p>/,
    );
    expect(html).not.toContain("$0.00");
    expect(html).toContain("Net P&amp;L 15.5 USDC");
    expect(html).toContain("closed");
    expect(html).toContain("out of range");
  });

  it("renders ledger USD fee as primary and token1 fees as secondary context", () => {
    const html = renderToStaticMarkup(<Dashboard positions={[activePosition]} />);

    expect(html).toContain('<th class="px-5 py-3">Fees</th>');
    expect(html).toMatch(
      /<td class="[^"]*"><div><p class="font-bold[^"]*">\$3\.23<\/p><p class="mt-1 text-xs text-neutral-500">12\.35 USDC<\/p><\/div><\/td>/,
    );
    expect(html).toContain("Fees 12.35 USDC");
  });

  it("shows USD unavailable instead of zero for missing USD fees", () => {
    const positionWithoutUsdFees: DashboardPosition = {
      ...activePosition,
      pnl: {
        ...activePosition.pnl!,
        feesValueUsd: null,
      },
    };

    const html = renderToStaticMarkup(<Dashboard positions={[positionWithoutUsdFees]} />);

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

    const html = renderToStaticMarkup(<Dashboard positions={[positionWithZeroUsdFees]} />);

    expect(html).toContain("$0.00");
  });
});
