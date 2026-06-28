import { describe, expect, it, mock } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { DashboardPosition, HedgeEvent } from "../../src/api";
import { UnassignedHedgeTradeRowView, UnassignedHedgeTradesPanel } from "../../src/App";

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
  currentAmount0: 1,
  currentAmount1: 100,
};

const closedPosition: DashboardPosition = {
  ...activePosition,
  tokenId: "456",
  status: "closed",
  inRange: false,
};

const openHedge: HedgeEvent = {
  id: 11,
  token_id: null,
  trade_key: null,
  tax_key: null,
  coin: "HYPE",
  status: "open",
  entry_px: 42.25,
  size: -3,
  opened_at: "2026-06-20T12:00:00.000Z",
  closed_at: null,
  close_px: null,
  realized_pnl: null,
  funding_earned: 12.34,
  close_reason: null,
  hl_fill_hash: null,
  current_szi: "-3.0",
  mark_px: 40.5,
  unrealized_pnl: 15.25,
  liquidation_px: 55,
  leverage_type: "isolated",
  leverage_value: 3,
  updated_at: "2026-06-20T13:00:00.000Z",
};

const closedHedge: HedgeEvent = {
  ...openHedge,
  id: 12,
  status: "closed",
  closed_at: "2026-06-21T12:00:00.000Z",
  close_px: 39.75,
  realized_pnl: 25.5,
  unrealized_pnl: null,
};

describe("UnassignedHedgeTradesPanel", () => {
  it("renders fetched unassigned hedge trades with assign controls", () => {
    const html = renderWithQueryClient(
      <UnassignedHedgeTradesPanel
        hedges={[openHedge]}
        positions={[activePosition, closedPosition]}
        isLoading={false}
      />,
    );

    expect(html).toContain("Unassigned Hedge Trades");
    expect(html).toContain("1 pending");
    expect(html).toContain("trade #11");
    expect(html).toContain("Assign to LP position");
    expect(html).toContain("Select position…");
    expect(html).toContain("Assign");
  });

  it("renders both active and closed positions as assignment targets", () => {
    const html = renderToStaticMarkup(
      <UnassignedHedgeTradeRowView
        hedge={openHedge}
        positions={[activePosition, closedPosition]}
        selectedTokenId=""
        onSelectedTokenIdChange={() => undefined}
        onAssign={() => undefined}
      />,
    );

    expect(html).toContain("WHYPE/USDC #123 · active");
    expect(html).toContain("WHYPE/USDC #456 · closed");
  });

  it("does not render the panel when the unassigned hedge list is empty", () => {
    const html = renderToStaticMarkup(
      <UnassignedHedgeTradesPanel hedges={[]} positions={[activePosition]} isLoading={false} />,
    );

    expect(html).toBe("");
  });

  it("renders a loading state before unassigned hedges arrive", () => {
    const html = renderToStaticMarkup(
      <UnassignedHedgeTradesPanel hedges={[]} positions={[activePosition]} isLoading />,
    );

    expect(html).toContain("Loading unassigned hedge trades…");
  });

  it("renders a panel-level error when unassigned hedges fail to load", () => {
    const html = renderToStaticMarkup(
      <UnassignedHedgeTradesPanel
        hedges={[]}
        positions={[activePosition]}
        error={new Error("Network down")}
      />,
    );

    expect(html).toContain("Could not load unassigned hedge trades");
    expect(html).toContain("Network down");
  });

  it("shows assignment errors inline while keeping the trade visible", () => {
    const html = renderToStaticMarkup(
      <UnassignedHedgeTradeRowView
        hedge={closedHedge}
        positions={[activePosition]}
        selectedTokenId="123"
        error={new Error("Assignment failed")}
        onSelectedTokenIdChange={() => undefined}
        onAssign={() => undefined}
      />,
    );

    expect(html).toContain("trade #12");
    expect(html).toContain("Assignment failed");
    expect(html).toContain("Assign");
  });

  it("keeps assign as an explicit confirm action", () => {
    const onAssign = mock(() => undefined);
    const onSelectedTokenIdChange = mock((_tokenId: string) => undefined);

    const row = UnassignedHedgeTradeRowView({
      hedge: openHedge,
      positions: [activePosition],
      selectedTokenId: "",
      onSelectedTokenIdChange,
      onAssign,
    });
    const select = findElementByType(row, "select");
    const button = findElementByType(row, "button");

    select.props.onChange({ target: { value: "123" } });

    expect(onSelectedTokenIdChange).toHaveBeenCalledWith("123");
    expect(onAssign).not.toHaveBeenCalled();

    button.props.onClick();

    expect(onAssign).toHaveBeenCalledTimes(1);
  });
});

function renderWithQueryClient(element: ReactElement): string {
  const queryClient = new QueryClient();

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

function findElementByType(node: ReactNode, type: string): ReactElement<any> {
  if (!node) {
    throw new Error(`Element of type ${type} not found`);
  }

  if (Array.isArray(node)) {
    for (const child of node) {
      try {
        return findElementByType(child, type);
      } catch {
        continue;
      }
    }
    throw new Error(`Element of type ${type} not found`);
  }

  if (!isValidElement(node)) {
    throw new Error(`Element of type ${type} not found`);
  }

  if (node.type === type) {
    return node;
  }

  const element = node as ReactElement<{ children?: ReactNode }>;

  return findElementByType(element.props.children, type);
}
