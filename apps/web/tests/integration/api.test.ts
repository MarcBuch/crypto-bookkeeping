import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  ApiError,
  getDashboardPositions,
  getPnL,
  getPositions,
  type PnLView,
  type PositionView,
} from "../../src/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = input.toString();
    return Promise.resolve(handler(url));
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const position: PositionView = {
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
  currentAmount1: 2,
};

const pnl: PnLView = {
  tokenId: "123",
  pair: "WHYPE/USDC",
  token0Symbol: "WHYPE",
  token1Symbol: "USDC",
  status: "active",
  entryPrice: 1,
  exitPrice: 1.5,
  priceChangePercent: 0.5,
  entryAmount0: 1,
  entryAmount1: 1,
  exitAmount0: 0.5,
  exitAmount1: 1.5,
  feesCollected0: 0.01,
  feesCollected1: 0.02,
  feesCollected0Usd: 0.03,
  feesCollected1Usd: 0.02,
  feesValueInToken1: 0.03,
  feesValueUsd: 0.05,
  token0UsdPrice: 3,
  token1UsdPrice: 1,
  usdPriceSource: "coingecko",
  entryValueInToken1: 2,
  exitValueInToken1: 2.25,
  holdValueInToken1: 2.5,
  absolutePnlInToken1: 0.25,
  absolutePnlPercent: 0.125,
  divergenceLossPercent: -0.02,
  opportunityCostInToken1: 0.25,
  netVsHodlPercent: -0.01,
  priceLower: 1,
  priceUpper: 2,
};

describe("API client", () => {
  it("propagates network failures when fetch rejects", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("fetch failed")),
    ) as unknown as typeof fetch;

    await expect(getPositions()).rejects.toThrow("fetch failed");
  });

  it("returns an empty positions list as valid data", async () => {
    mockFetch(() => jsonResponse({ positions: [] }));

    await expect(getPositions()).resolves.toEqual([]);
  });

  it("throws API errors from non-2xx JSON responses", async () => {
    mockFetch(() => jsonResponse({ error: "RPC rate limited" }, 503));

    await expect(getPnL()).rejects.toMatchObject({
      name: "ApiError",
      message: "RPC rate limited",
      status: 503,
    });
  });

  it("throws stable generic errors for non-JSON failures", async () => {
    mockFetch(() => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }));

    await expect(getPositions()).rejects.toMatchObject({
      message: "API request failed with status 502",
      status: 502,
    });
  });

  it("throws when positions response has malformed shape", async () => {
    mockFetch(() => jsonResponse({ positions: null }));

    await expect(getPositions()).rejects.toBeInstanceOf(ApiError);
    await expect(getPositions()).rejects.toThrow("API response did not include positions.");
  });

  it("throws when P&L response has malformed shape", async () => {
    mockFetch(() => jsonResponse({ data: [] }));

    await expect(getPnL()).rejects.toThrow("API response did not include P&L positions.");
  });

  it("merges positions and P&L by tokenId", async () => {
    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [pnl] });
    });

    const dashboardPositions = await getDashboardPositions();
    expect(dashboardPositions).toEqual([{ ...position, pnl }]);
    expect(dashboardPositions[0]?.pnl?.feesValueUsd).toBe(0.05);
    expect(dashboardPositions[0]?.pnl?.usdPriceSource).toBe("coingecko");
  });

  it("preserves complete USD fee fields through dashboard merge", async () => {
    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [pnl] });
    });

    const dashboardPositions = await getDashboardPositions();

    expect(dashboardPositions[0]?.pnl).toMatchObject({
      feesCollected0Usd: 0.03,
      feesCollected1Usd: 0.02,
      feesValueUsd: 0.05,
      token0UsdPrice: 3,
      token1UsdPrice: 1,
      usdPriceSource: "coingecko",
    });
  });

  it("preserves null USD fee fields through dashboard merge", async () => {
    const nullUsdPnl: PnLView = {
      ...pnl,
      feesCollected0Usd: null,
      feesCollected1Usd: null,
      feesValueUsd: null,
      token0UsdPrice: null,
      token1UsdPrice: null,
      usdPriceSource: null,
    };

    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [nullUsdPnl] });
    });

    const dashboardPositions = await getDashboardPositions();

    expect(dashboardPositions[0]?.pnl).toMatchObject({
      feesCollected0Usd: null,
      feesCollected1Usd: null,
      feesValueUsd: null,
      token0UsdPrice: null,
      token1UsdPrice: null,
      usdPriceSource: null,
    });
  });

  it("keeps older P&L responses with missing USD fee fields stable", async () => {
    const {
      feesCollected0Usd: _feesCollected0Usd,
      feesCollected1Usd: _feesCollected1Usd,
      feesValueUsd: _feesValueUsd,
      token0UsdPrice: _token0UsdPrice,
      token1UsdPrice: _token1UsdPrice,
      usdPriceSource: _usdPriceSource,
      ...legacyPnl
    } = pnl;

    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [legacyPnl] });
    });

    const dashboardPositions = await getDashboardPositions();

    expect(dashboardPositions).toEqual([{ ...position, pnl: legacyPnl }]);
    expect(dashboardPositions[0]?.pnl?.feesValueUsd).toBeUndefined();
    expect(dashboardPositions[0]?.pnl?.usdPriceSource).toBeUndefined();
  });

  it("keeps positions when no matching P&L exists", async () => {
    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [] });
    });

    await expect(getDashboardPositions()).resolves.toEqual([{ ...position, pnl: undefined }]);
  });
});
