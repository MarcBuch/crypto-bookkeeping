import { afterEach, describe, expect, it, mock } from "bun:test";

import {
  ApiError,
  createTaxTransaction,
  getDashboardPositions,
  getPnL,
  getPositions,
  getTaxTransactions,
  syncTaxTransactions,
  updateTaxTransaction,
  type PnLView,
  type PositionView,
  type TaxTransaction,
} from "../../src/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    return Promise.resolve(handler(url, init));
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

const taxTransaction: TaxTransaction = {
  id: "hyperevmscan:txlist:0xhash:external",
  hash: "0xhash",
  block_number: 123,
  time_stamp: "1760000000",
  from_address: "0xfrom",
  to_address: "0xto",
  value: "1000000000000000000",
  gas_used: "21000",
  gas_price: "1000000000",
  fee: "21000000000000",
  method_id: "0x12345678",
  function_name: "transfer(address,uint256)",
  input: "0x12345678",
  contract_address: null,
  token_symbol: null,
  token_decimal: null,
  token_name: null,
  transaction_type: "external",
  source: "hyperevmscan",
  is_error: 0,
  label: "Trade",
  incoming_quantity: null,
  incoming_asset: null,
  outgoing_quantity: null,
  outgoing_asset: null,
  cost_eur: null,
  proceeds_eur: null,
  gain_eur: null,
  holding_duration_days: null,
  comment: null,
  synced_at: "2026-05-30T12:00:00.000Z",
  created_at: "2026-05-30T12:00:00.000Z",
  updated_at: "2026-05-30T12:00:00.000Z",
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

    await expect(getPositions()).resolves.toEqual({ positions: [], syncedAt: null });
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

    const { positions: dashboardPositions } = await getDashboardPositions();
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

    const { positions: dashboardPositions } = await getDashboardPositions();

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

    const { positions: dashboardPositions } = await getDashboardPositions();

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

    const { positions: dashboardPositions } = await getDashboardPositions();

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

    await expect(getDashboardPositions()).resolves.toMatchObject({ positions: [{ ...position, pnl: undefined }] });
  });

  it("fetches tax transactions with pagination and label filters", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBeUndefined();
      expect(url).toBe("http://localhost:3000/tax/transactions?limit=10&offset=5&label=Trade");
      return jsonResponse({ transactions: [taxTransaction] });
    });

    await expect(getTaxTransactions({ limit: 10, offset: 5, label: "Trade" })).resolves.toEqual([
      taxTransaction,
    ]);
  });

  it("omits null tax labels while preserving zero offset and provided limit", async () => {
    mockFetch((url) => {
      expect(url).toBe("http://localhost:3000/tax/transactions?limit=25&offset=0");
      return jsonResponse({ transactions: [] });
    });

    await expect(getTaxTransactions({ limit: 25, offset: 0, label: null })).resolves.toEqual([]);
  });

  it("throws when tax transactions response lacks a transactions array", async () => {
    mockFetch(() => jsonResponse({}));

    await expect(getTaxTransactions()).rejects.toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transactions.",
    });
  });

  it("throws when tax transactions response has null transactions", async () => {
    mockFetch(() => jsonResponse({ transactions: null }));

    await expect(getTaxTransactions()).rejects.toThrow(
      "API response did not include tax transactions.",
    );
  });

  it("throws when tax transactions contain missing id or hash", async () => {
    mockFetch(() => jsonResponse({ transactions: [{ ...taxTransaction, hash: undefined }] }));

    await expect(getTaxTransactions()).rejects.toThrow(
      "API response included malformed tax transactions.",
    );
  });

  it("propagates tax transactions non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("upstream unavailable", { status: 503 }));

    await expect(getTaxTransactions()).rejects.toMatchObject({
      name: "ApiError",
      message: "API request failed with status 503",
      status: 503,
    });
  });

  it("syncs tax transactions with POST", async () => {
    const summary = { synced: 2, insertedOrUpdated: 2, source: "hyperevmscan" };
    mockFetch((url, init) => {
      expect(url).toBe("http://localhost:3000/tax/transactions/sync");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return jsonResponse({ sync: summary });
    });

    await expect(syncTaxTransactions()).resolves.toEqual(summary);
  });

  it("throws when tax sync response lacks a sync object", async () => {
    mockFetch(() => jsonResponse({}));

    await expect(syncTaxTransactions()).rejects.toMatchObject({
      name: "ApiError",
      message: "API response did not include tax sync summary.",
    });
  });

  it("throws when tax sync response has null or array sync", async () => {
    mockFetch(() => jsonResponse({ sync: null }));
    await expect(syncTaxTransactions()).rejects.toThrow(
      "API response did not include tax sync summary.",
    );

    mockFetch(() => jsonResponse({ sync: [] }));
    await expect(syncTaxTransactions()).rejects.toThrow(
      "API response did not include tax sync summary.",
    );
  });

  it("propagates tax sync non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "sync failed" }, 409));

    await expect(syncTaxTransactions()).rejects.toMatchObject({
      name: "ApiError",
      message: "sync failed",
      status: 409,
    });
  });

  it("propagates tax sync non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("gateway timeout", { status: 504 }));

    await expect(syncTaxTransactions()).rejects.toMatchObject({
      name: "ApiError",
      message: "API request failed with status 504",
      status: 504,
    });
  });

  it("creates manual tax transactions with JSON POST", async () => {
    const input = {
      hash: "manual:2026-05-31",
      time_stamp: "1760000000",
      label: "Trade" as const,
      incoming_quantity: "100.5",
      incoming_asset: "USDC",
      outgoing_quantity: "1.25",
      outgoing_asset: "WHYPE",
      fee: "0.01",
      comment: "Manual import",
    };
    const created = { ...taxTransaction, ...input, id: "manual:manual:2026-05-31" };

    mockFetch((url, init) => {
      expect(url).toBe("http://localhost:3000/tax/transactions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(init?.body).toBe(JSON.stringify(input));
      return jsonResponse({ transaction: created });
    });

    await expect(createTaxTransaction(input)).resolves.toEqual(created);
  });

  it("throws when tax create response lacks a transaction object", async () => {
    mockFetch(() => jsonResponse({}));

    await expect(createTaxTransaction({ hash: "manual:missing" })).rejects.toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transaction.",
    });
  });

  it("throws when tax create response transaction misses id or hash", async () => {
    mockFetch(() => jsonResponse({ transaction: { ...taxTransaction, hash: undefined } }));

    await expect(createTaxTransaction({ hash: "manual:malformed" })).rejects.toMatchObject({
      name: "ApiError",
      message: "API response included malformed tax transaction.",
    });
  });

  it("propagates tax create non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "manual transaction already exists" }, 409));

    await expect(createTaxTransaction({ hash: "manual:duplicate" })).rejects.toMatchObject({
      name: "ApiError",
      message: "manual transaction already exists",
      status: 409,
    });

    mockFetch(() => jsonResponse({ error: "hash is required" }, 400));

    await expect(createTaxTransaction({})).rejects.toMatchObject({
      name: "ApiError",
      message: "hash is required",
      status: 400,
    });
  });

  it("propagates tax create non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("conflict", { status: 409 }));

    await expect(createTaxTransaction({ hash: "manual:non-json" })).rejects.toMatchObject({
      name: "ApiError",
      message: "API request failed with status 409",
      status: 409,
    });
  });

  it("propagates tax create network failures when fetch rejects", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new TypeError("create fetch failed")),
    ) as unknown as typeof fetch;

    await expect(createTaxTransaction({ hash: "manual:network" })).rejects.toThrow(
      "create fetch failed",
    );
  });

  it("updates tax transaction metadata with PATCH", async () => {
    const updated = { ...taxTransaction, label: "Transfer" as const, comment: "Manual" };
    mockFetch((url, init) => {
      expect(url).toBe(
        "http://localhost:3000/tax/transactions/hyperevmscan%3Atxlist%3A0xhash%3Aexternal",
      );
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ label: "Transfer", comment: "Manual" }));
      return jsonResponse({ transaction: updated });
    });

    await expect(
      updateTaxTransaction(taxTransaction.id, { label: "Transfer", comment: "Manual" }),
    ).resolves.toEqual(updated);
  });

  it("URL-encodes tax transaction ids with reserved URL characters", async () => {
    const id = "scan:tx#hash/path?kind=external";
    mockFetch((url) => {
      expect(url).toBe(
        "http://localhost:3000/tax/transactions/scan%3Atx%23hash%2Fpath%3Fkind%3Dexternal",
      );
      return jsonResponse({ transaction: { ...taxTransaction, id } });
    });

    await expect(updateTaxTransaction(id, { comment: "reserved chars" })).resolves.toMatchObject({
      id,
    });
  });

  it("throws when tax update response lacks a transaction object", async () => {
    mockFetch(() => jsonResponse({}));

    await expect(
      updateTaxTransaction(taxTransaction.id, { comment: "Manual" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transaction.",
    });
  });

  it("throws when tax update response has null or array transaction", async () => {
    mockFetch(() => jsonResponse({ transaction: null }));
    await expect(updateTaxTransaction(taxTransaction.id, { comment: "Manual" })).rejects.toThrow(
      "API response did not include tax transaction.",
    );

    mockFetch(() => jsonResponse({ transaction: [] }));
    await expect(updateTaxTransaction(taxTransaction.id, { comment: "Manual" })).rejects.toThrow(
      "API response did not include tax transaction.",
    );
  });

  it("throws when tax update response transaction misses id or hash", async () => {
    mockFetch(() => jsonResponse({ transaction: { ...taxTransaction, id: undefined } }));

    await expect(updateTaxTransaction(taxTransaction.id, { comment: "Manual" })).rejects.toThrow(
      "API response included malformed tax transaction.",
    );
  });

  it("propagates tax update non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "annotation rejected" }, 422));

    await expect(updateTaxTransaction(taxTransaction.id, { label: "Trade" })).rejects.toMatchObject(
      {
        name: "ApiError",
        message: "annotation rejected",
        status: 422,
      },
    );
  });

  it("propagates tax update non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("service unavailable", { status: 503 }));

    await expect(
      updateTaxTransaction(taxTransaction.id, { label: "Transfer" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "API request failed with status 503",
      status: 503,
    });
  });
});
