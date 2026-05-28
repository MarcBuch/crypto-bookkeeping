import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Dashboard,
  EmptyState,
  ErrorState,
  LoadingState,
} from "./App";
import type { DashboardPosition } from "./api";

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
    feesValueInToken1: 12.345,
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
    const html = renderToStaticMarkup(
      <Dashboard positions={[activePosition, closedPosition]} />
    );

    expect(html).toContain("WHYPE/USDC");
    expect(html).toContain("active");
    expect(html).toContain("closed");
    expect(html).toContain("in range");
    expect(html).toContain("out of range");
    expect(html).toContain("1/2");
  });

  it("formats positive and negative P&L values and decimal percentages", () => {
    const html = renderToStaticMarkup(
      <Dashboard positions={[activePosition, closedPosition]} />
    );

    expect(html).toContain("25.5 USDC");
    expect(html).toContain("-10 USDC");
    expect(html).toContain("25.5%");
    expect(html).toContain("-10%");
    expect(html).toContain("text-emerald-300");
    expect(html).toContain("text-red-300");
  });
});
