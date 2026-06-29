import { afterEach, describe, expect, it } from "bun:test";

import {
  ApiError,
  assignHedgeEvent,
  createTaxTransaction,
  getDashboardPositions,
  getHedges,
  getPnL,
  getPositions,
  getTaxTransactions,
  syncTaxTransactions,
  updateTaxTransaction,
  type HedgeEvent,
  type PnLView,
  type PositionView,
  type TaxTransaction,
} from "../../src/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function captureError<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }

  throw new Error("Expected promise to reject");
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isRequestInfoOrUrl(value: unknown): value is RequestInfo | URL {
  return typeof value === "string" || value instanceof URL || value instanceof Request;
}

function isRequestInit(value: unknown): value is RequestInit {
  return value !== null && typeof value === "object";
}

function createFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return new Proxy(originalFetch, {
    apply(_target, _thisArg, argArray) {
      const [input, init] = argArray;
      if (!isRequestInfoOrUrl(input)) {
        throw new TypeError("Unsupported fetch input");
      }

      return Promise.resolve(handler(getRequestUrl(input), isRequestInit(init) ? init : undefined));
    },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = createFetchMock(handler);
}

function createRejectedFetch(message: string): typeof fetch {
  return new Proxy(originalFetch, {
    apply() {
      return Promise.reject(new TypeError(message));
    },
  });
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
  openedAt: "2026-06-01T00:00:00.000Z",
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
  pendingFeesValueInToken1: 0,
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

const hedgeEvent: HedgeEvent = {
  id: 7,
  token_id: null,
  trade_key: "trade:fill:HYPE:7",
  tax_key: "tax:fill:HYPE:7",
  coin: "HYPE",
  status: "closed",
  entry_px: 24,
  size: 10,
  opened_at: "2026-05-30T12:00:00.000Z",
  closed_at: "2026-05-30T13:00:00.000Z",
  close_px: 22,
  realized_pnl: 20,
  funding_earned: 1.5,
  close_reason: "manual",
  hl_fill_hash: "0xfill",
  current_szi: null,
  mark_px: 22,
  unrealized_pnl: null,
  liquidation_px: null,
  leverage_type: "cross",
  leverage_value: 1,
  updated_at: "2026-05-30T13:00:00.000Z",
};

describe("API client", () => {
  it("propagates network failures when fetch rejects", async () => {
    globalThis.fetch = createRejectedFetch("fetch failed");

    const error = await captureError(getPositions());
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("fetch failed");
  });

  it("returns an empty positions list as valid data", async () => {
    mockFetch(() => jsonResponse({ positions: [] }));

    const result = await getPositions();
    expect(result).toEqual({ positions: [], syncedAt: null });
  });

  it("throws API errors from non-2xx JSON responses", async () => {
    mockFetch(() => jsonResponse({ error: "RPC rate limited" }, 503));

    const error = await captureError(getPnL());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "RPC rate limited",
      status: 503,
    });
  });

  it("throws stable generic errors for non-JSON failures", async () => {
    mockFetch(() => new Response("bad gateway", { status: 502, statusText: "Bad Gateway" }));

    const error = await captureError(getPositions());
    expect(error).toMatchObject({
      message: "API request failed with status 502",
      status: 502,
    });
  });

  it("throws when positions response has malformed shape", async () => {
    mockFetch(() => jsonResponse({ positions: null }));

    const error = await captureError(getPositions());
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain("API response did not include positions.");
  });

  it("throws when P&L response has malformed shape", async () => {
    mockFetch(() => jsonResponse({ data: [] }));

    const error = await captureError(getPnL());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include P&L positions.");
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

  it("preserves hedge metadata from positions when merging dashboard rows", async () => {
    const positionWithHedge: PositionView = {
      ...position,
      hedge: {
        coin: "HYPE",
      },
    };

    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [positionWithHedge] });
      }

      return jsonResponse({ positions: [pnl] });
    });

    const { positions: dashboardPositions } = await getDashboardPositions();
    expect(dashboardPositions[0]).toEqual({ ...positionWithHedge, pnl });
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
      openedAt: "2026-06-01T00:00:00.000Z",
      feesCollected0Usd: 0.03,
      feesCollected1Usd: 0.02,
      feesValueUsd: 0.05,
      token0UsdPrice: 3,
      token1UsdPrice: 1,
      usdPriceSource: "coingecko",
    });
  });

  it("keeps older P&L responses with fees but missing openedAt stable", async () => {
    const { openedAt: _openedAt, ...legacyPnl } = pnl;

    mockFetch((url) => {
      if (url.endsWith("/positions")) {
        return jsonResponse({ positions: [position] });
      }

      return jsonResponse({ positions: [legacyPnl] });
    });

    const { positions: dashboardPositions } = await getDashboardPositions();

    expect(dashboardPositions).toEqual([{ ...position, pnl: legacyPnl }]);
    expect(dashboardPositions[0]?.pnl?.feesValueUsd).toBe(0.05);
    expect(dashboardPositions[0]?.pnl?.openedAt).toBeUndefined();
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

    const result = await getDashboardPositions();
    expect(result).toMatchObject({
      positions: [{ ...position, pnl: undefined }],
    });
  });

  it("fetches hedges filtered by assignment state", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBeUndefined();
      expect(url).toBe("http://localhost:3000/hedges?assigned=unassigned");
      return jsonResponse({ hedges: [hedgeEvent] });
    });

    const result = await getHedges({ assigned: "unassigned" });
    expect(result).toEqual({ hedges: [hedgeEvent] });
  });

  it("throws when hedges response lacks a hedges array", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(getHedges());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include hedges.",
    });
  });

  it("assigns a hedge event with PATCH", async () => {
    const assignedHedge = { ...hedgeEvent, token_id: "123" };
    mockFetch((url, init) => {
      expect(url).toBe("http://localhost:3000/hedges/7/assignment");
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ tokenId: "123" }));
      return jsonResponse({ hedge: assignedHedge });
    });

    const result = await assignHedgeEvent(7, "123");
    expect(result).toEqual({ hedge: assignedHedge });
  });

  it("throws when hedge assignment response lacks a hedge object", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(assignHedgeEvent(7, "123"));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include hedge.",
    });
  });

  it("fetches tax transactions with pagination and label filters", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBeUndefined();
      expect(url).toBe("http://localhost:3000/tax/transactions?limit=10&offset=5&label=Trade");
      return jsonResponse({
        transactions: [taxTransaction],
        pagination: { limit: 10, offset: 5, label: "Trade", total: 1 },
      });
    });

    const result = await getTaxTransactions({ limit: 10, offset: 5, label: "Trade" });
    expect(result).toEqual({
      transactions: [taxTransaction],
      pagination: { limit: 10, offset: 5, label: "Trade", total: 1 },
    });
  });

  it("fetches tax transactions filtered by Approval label", async () => {
    const approvalTaxTransaction = { ...taxTransaction, label: "Approval" as const };
    mockFetch((url, init) => {
      expect(init?.method).toBeUndefined();
      expect(url).toBe("http://localhost:3000/tax/transactions?label=Approval");
      return jsonResponse({
        transactions: [approvalTaxTransaction],
        pagination: { limit: 200, offset: 0, label: "Approval", total: 1 },
      });
    });

    const result = await getTaxTransactions({ label: "Approval" });
    expect(result).toEqual({
      transactions: [approvalTaxTransaction],
      pagination: { limit: 200, offset: 0, label: "Approval", total: 1 },
    });
  });

  it("accepts null pagination labels for unfiltered tax transactions", async () => {
    mockFetch((url, init) => {
      expect(init?.method).toBeUndefined();
      expect(url).toBe("http://localhost:3000/tax/transactions");
      return jsonResponse({
        transactions: [taxTransaction],
        pagination: { limit: 50, offset: 0, label: null, total: 1 },
      });
    });

    const result = await getTaxTransactions();
    expect(result).toEqual({
      transactions: [taxTransaction],
      pagination: { limit: 50, offset: 0, label: null, total: 1 },
    });
  });

  it("omits null tax labels while preserving zero offset and provided limit", async () => {
    mockFetch((url) => {
      expect(url).toBe("http://localhost:3000/tax/transactions?limit=25&offset=0");
      return jsonResponse({
        transactions: [],
        pagination: { limit: 25, offset: 0, label: null, total: 0 },
      });
    });

    const result = await getTaxTransactions({ limit: 25, offset: 0, label: null });
    expect(result).toEqual({
      transactions: [],
      pagination: { limit: 25, offset: 0, label: null, total: 0 },
    });
  });

  it("throws when tax transactions response lacks a transactions array", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(getTaxTransactions());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transactions.",
    });
  });

  it("throws when tax transactions response lacks pagination", async () => {
    mockFetch(() => jsonResponse({ transactions: [taxTransaction] }));

    const error = await captureError(getTaxTransactions());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transactions pagination.",
    });
  });

  it("throws when tax transactions response has null transactions", async () => {
    mockFetch(() => jsonResponse({ transactions: null }));

    const error = await captureError(getTaxTransactions());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include tax transactions.");
  });

  it("throws when tax transactions contain missing id or hash", async () => {
    mockFetch(() =>
      jsonResponse({
        transactions: [{ ...taxTransaction, hash: undefined }],
        pagination: { limit: 200, offset: 0, label: null, total: 1 },
      }),
    );

    const error = await captureError(getTaxTransactions());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response included malformed tax transactions.");
  });

  it("propagates tax transactions non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("upstream unavailable", { status: 503 }));

    const error = await captureError(getTaxTransactions());
    expect(error).toMatchObject({
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

    const result = await syncTaxTransactions();
    expect(result).toEqual(summary);
  });

  it("throws when tax sync response lacks a sync object", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(syncTaxTransactions());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include tax sync summary.",
    });
  });

  it("throws when tax sync response has null or array sync", async () => {
    mockFetch(() => jsonResponse({ sync: null }));
    let error = await captureError(syncTaxTransactions());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include tax sync summary.");

    mockFetch(() => jsonResponse({ sync: [] }));
    error = await captureError(syncTaxTransactions());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include tax sync summary.");
  });

  it("propagates tax sync non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "sync failed" }, 409));

    const error = await captureError(syncTaxTransactions());
    expect(error).toMatchObject({
      name: "ApiError",
      message: "sync failed",
      status: 409,
    });
  });

  it("propagates tax sync non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("gateway timeout", { status: 504 }));

    const error = await captureError(syncTaxTransactions());
    expect(error).toMatchObject({
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

    const result = await createTaxTransaction(input);
    expect(result).toEqual(created);
  });

  it("throws when tax create response lacks a transaction object", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(createTaxTransaction({ hash: "manual:missing" }));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transaction.",
    });
  });

  it("throws when tax create response transaction misses id or hash", async () => {
    mockFetch(() => jsonResponse({ transaction: { ...taxTransaction, hash: undefined } }));

    const error = await captureError(createTaxTransaction({ hash: "manual:malformed" }));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response included malformed tax transaction.",
    });
  });

  it("propagates tax create non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "manual transaction already exists" }, 409));

    let error = await captureError(createTaxTransaction({ hash: "manual:duplicate" }));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "manual transaction already exists",
      status: 409,
    });

    mockFetch(() => jsonResponse({ error: "hash is required" }, 400));

    error = await captureError(createTaxTransaction({}));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "hash is required",
      status: 400,
    });
  });

  it("propagates tax create non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("conflict", { status: 409 }));

    const error = await captureError(createTaxTransaction({ hash: "manual:non-json" }));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API request failed with status 409",
      status: 409,
    });
  });

  it("propagates tax create network failures when fetch rejects", async () => {
    globalThis.fetch = createRejectedFetch("create fetch failed");

    const error = await captureError(createTaxTransaction({ hash: "manual:network" }));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain("create fetch failed");
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

    const result = await updateTaxTransaction(taxTransaction.id, {
      label: "Transfer",
      comment: "Manual",
    });
    expect(result).toEqual(updated);
  });

  it("URL-encodes tax transaction ids with reserved URL characters", async () => {
    const id = "scan:tx#hash/path?kind=external";
    mockFetch((url) => {
      expect(url).toBe(
        "http://localhost:3000/tax/transactions/scan%3Atx%23hash%2Fpath%3Fkind%3Dexternal",
      );
      return jsonResponse({ transaction: { ...taxTransaction, id } });
    });

    const result = await updateTaxTransaction(id, { comment: "reserved chars" });
    expect(result).toMatchObject({
      id,
    });
  });

  it("throws when tax update response lacks a transaction object", async () => {
    mockFetch(() => jsonResponse({}));

    const error = await captureError(
      updateTaxTransaction(taxTransaction.id, { comment: "Manual" }),
    );
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API response did not include tax transaction.",
    });
  });

  it("throws when tax update response has null or array transaction", async () => {
    mockFetch(() => jsonResponse({ transaction: null }));
    let error = await captureError(updateTaxTransaction(taxTransaction.id, { comment: "Manual" }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include tax transaction.");

    mockFetch(() => jsonResponse({ transaction: [] }));
    error = await captureError(updateTaxTransaction(taxTransaction.id, { comment: "Manual" }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response did not include tax transaction.");
  });

  it("throws when tax update response transaction misses id or hash", async () => {
    mockFetch(() => jsonResponse({ transaction: { ...taxTransaction, id: undefined } }));

    const error = await captureError(
      updateTaxTransaction(taxTransaction.id, { comment: "Manual" }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("API response included malformed tax transaction.");
  });

  it("propagates tax update non-2xx JSON server errors", async () => {
    mockFetch(() => jsonResponse({ error: "annotation rejected" }, 422));

    const error = await captureError(updateTaxTransaction(taxTransaction.id, { label: "Trade" }));
    expect(error).toMatchObject({
      name: "ApiError",
      message: "annotation rejected",
      status: 422,
    });
  });

  it("propagates tax update non-JSON failures with generic status message", async () => {
    mockFetch(() => new Response("service unavailable", { status: 503 }));

    const error = await captureError(
      updateTaxTransaction(taxTransaction.id, { label: "Transfer" }),
    );
    expect(error).toMatchObject({
      name: "ApiError",
      message: "API request failed with status 503",
      status: 503,
    });
  });
});
