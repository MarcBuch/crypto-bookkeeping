import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { assignHedgeEvent, getHedgeEvent, insertHedgeEvent, listHedgeEvents } from "../db/store.js";
import { groupHyperliquidHedgeFills, syncHyperliquidHedgeTrades } from "../services/hedge.js";
import { jsonResponse, setFetchMock, getRequestType } from "./helpers/http.js";
import { useTestDb } from "./helpers/db.js";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

const baseConfig = {
  rpc: "http://test-rpc",
  chainId: 999,
  wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`,
  contracts: {
    factory: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    positionManager: "0x0000000000000000000000000000000000000002" as `0x${string}`,
    quoter: "0x0000000000000000000000000000000000000003" as `0x${string}`,
    swapRouter: "0x0000000000000000000000000000000000000004" as `0x${string}`,
  },
};

const originalFetch = globalThis.fetch;

useTestDb();

function mockHyperliquidResponses(params: {
  fills: unknown[];
  activeSzi?: string;
  activeEntryPx?: string;
  activeUnrealizedPnl?: string;
  activeFundingSinceOpen?: string | null;
  activeLeverage?: { type: string; value: number };
  activeLiquidationPx?: string;
  activeMarkPx?: string;
}): void {
  setFetchMock(async (_input: FetchInput, init?: FetchInit) => {
    const requestType = getRequestType(init);
    if (requestType === "userFillsByTime") {
      return jsonResponse(params.fills);
    }
    if (requestType === "clearinghouseState") {
      return jsonResponse({
        assetPositions:
          params.activeSzi == null
            ? []
            : [
                {
                  position: {
                    coin: "HYPE",
                    szi: params.activeSzi,
                    entryPx: params.activeEntryPx ?? "120",
                    positionValue: "240",
                    unrealizedPnl: params.activeUnrealizedPnl ?? "5",
                    ...(params.activeFundingSinceOpen === null
                      ? {}
                      : {
                          cumFunding: {
                            sinceOpen: params.activeFundingSinceOpen ?? "1.5",
                          },
                        }),
                    leverage: params.activeLeverage ?? { type: "cross", value: 3 },
                    liquidationPx: params.activeLiquidationPx ?? "80",
                    markPx: params.activeMarkPx ?? "122",
                  },
                  type: "perp",
                },
              ],
      });
    }
    throw new Error(`unexpected request type: ${requestType}`);
  });
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("groupHyperliquidHedgeFills", () => {
  it("splits reversal fills at zero crossing", () => {
    const result = groupHyperliquidHedgeFills([
      {
        coin: "HYPE",
        px: "100",
        sz: "1",
        side: "A",
        time: 1,
        closedPnl: "0",
        oid: 1,
        tid: 10,
        dir: "Open Short",
      },
      {
        coin: "HYPE",
        px: "110",
        sz: "2",
        side: "B",
        time: 2,
        closedPnl: "7",
        oid: 2,
        tid: 11,
        dir: "Close Short",
      },
    ]);

    expect(result.closedLifecycles).toHaveLength(1);
    expect(result.closedLifecycles[0]?.netInventory).toBe(0);
    expect(result.closedLifecycles[0]?.closingFills.map((fill) => fill.sz)).toEqual(["1"]);
    expect(result.activeLifecycle?.openingFills.map((fill) => fill.sz)).toEqual(["1"]);
    expect(result.activeLifecycle?.openingFills[0]?.closedPnl).toBe("0");
  });

  it("starts a new lifecycle after going flat instead of merging round trips", () => {
    const result = groupHyperliquidHedgeFills([
      {
        coin: "HYPE",
        px: "100",
        sz: "1",
        side: "A",
        time: 1,
        closedPnl: "0",
        oid: 1,
        tid: 1001,
        dir: "Open Short",
      },
      {
        coin: "HYPE",
        px: "95",
        sz: "1",
        side: "B",
        time: 2,
        closedPnl: "5",
        oid: 2,
        tid: 2002,
        dir: "Close Short",
      },
      {
        coin: "HYPE",
        px: "120",
        sz: "2",
        side: "A",
        time: 3,
        closedPnl: "0",
        oid: 3,
        tid: 3003,
        dir: "Open Short",
      },
    ]);

    expect(result.closedLifecycles).toHaveLength(1);
    expect(result.closedLifecycles[0]?.openingFills.map((fill) => fill.tid)).toEqual([1001]);
    expect(result.closedLifecycles[0]?.closingFills.map((fill) => fill.tid)).toEqual([2002]);
    expect(result.activeLifecycle?.openingFills.map((fill) => fill.tid)).toEqual([3003]);
    expect(result.activeLifecycle?.closingFills).toEqual([]);
  });
});

describe("syncHyperliquidHedgeTrades", () => {
  it("groups partial opens and closes into one closed lifecycle with vwap prices and summed pnl", async () => {
    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "110",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-01T00:01:00.000Z"),
          closedPnl: "0",
          oid: 2,
          tid: 1002,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "115",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "5",
          oid: 3,
          tid: 2001,
          dir: "Close Short",
        },
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "B",
          time: Date.parse("2024-01-02T00:01:00.000Z"),
          closedPnl: "8",
          oid: 4,
          tid: 2002,
          dir: "Close Short",
        },
      ],
    });

    const discovered = await syncHyperliquidHedgeTrades(baseConfig);

    expect(discovered).toBe(1);
    expect(listHedgeEvents()).toHaveLength(1);
    expect(listHedgeEvents()[0]).toMatchObject({
      status: "closed",
      entry_px: 320 / 3,
      size: 3,
      close_px: 355 / 3,
      realized_pnl: 13,
      trade_key: "trade:fill:HYPE:2002",
      hl_fill_hash: "2002",
      close_reason: "manual_close",
    });
  });

  it("creates one closed lifecycle plus one active lifecycle for open-flat-open sequences", async () => {
    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "95",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "5",
          oid: 2,
          tid: 2002,
          dir: "Close Short",
        },
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-2",
    });

    const discovered = await syncHyperliquidHedgeTrades(baseConfig);

    expect(discovered).toBe(2);
    expect(listHedgeEvents()).toHaveLength(2);
    expect(listHedgeEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "closed",
          trade_key: "trade:fill:HYPE:2002",
          hl_fill_hash: "2002",
        }),
        expect.objectContaining({
          status: "open",
          trade_key: "trade:hl:HYPE:3003",
          tax_key: `tax:hl:${baseConfig.wallet}:HYPE:3003`,
          opened_at: "2024-01-03T00:00:00.000Z",
        }),
      ]),
    );
  });

  it("is idempotent when re-running discovery with the same fills", async () => {
    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "95",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "5",
          oid: 2,
          tid: 2002,
          dir: "Close Short",
        },
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-2",
    });

    const firstDiscovered = await syncHyperliquidHedgeTrades(baseConfig);
    const firstEvents = listHedgeEvents().map((event) => ({
      id: event.id,
      trade_key: event.trade_key,
      status: event.status,
      hl_fill_hash: event.hl_fill_hash,
    }));

    const secondDiscovered = await syncHyperliquidHedgeTrades(baseConfig);
    const secondEvents = listHedgeEvents().map((event) => ({
      id: event.id,
      trade_key: event.trade_key,
      status: event.status,
      hl_fill_hash: event.hl_fill_hash,
    }));

    expect(firstDiscovered).toBe(2);
    expect(secondDiscovered).toBe(2);
    expect(secondEvents).toEqual(firstEvents);
    expect(listHedgeEvents()).toHaveLength(2);
  });

  it("imports live active position fields and keeps unknown funding nullable when active fill history exists", async () => {
    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "119",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-1",
      activeEntryPx: "123.45",
      activeUnrealizedPnl: "6.7",
      activeFundingSinceOpen: null,
      activeLeverage: { type: "isolated", value: 5 },
      activeLiquidationPx: "150.5",
      activeMarkPx: "124.75",
    });

    const discovered = await syncHyperliquidHedgeTrades(baseConfig);

    expect(discovered).toBe(1);
    expect(listHedgeEvents()).toHaveLength(1);
    expect(listHedgeEvents()[0]).toMatchObject({
      status: "open",
      trade_key: "trade:hl:HYPE:3003",
      tax_key: `tax:hl:${baseConfig.wallet}:HYPE:3003`,
      opened_at: "2024-01-03T00:00:00.000Z",
      current_szi: "-1",
      mark_px: 124.75,
      unrealized_pnl: 6.7,
      funding_earned: null,
      leverage_type: "isolated",
      leverage_value: 5,
      liquidation_px: 150.5,
      entry_px: 123.45,
      size: 1,
    });
  });

  it("closes stale open lifecycle and creates a fresh active lifecycle after close-and-reopen", async () => {
    insertHedgeEvent({
      token_id: null,
      coin: "HYPE",
      status: "open",
      entry_px: 100,
      size: 1,
      opened_at: "2024-01-01T00:00:00.000Z",
      closed_at: null,
      close_px: null,
      realized_pnl: null,
      funding_earned: null,
      close_reason: null,
      hl_fill_hash: null,
      trade_key: "trade:hl:HYPE:1001",
      tax_key: "tax:manual:keep-stale",
      current_szi: "-1",
      mark_px: 101,
      unrealized_pnl: 1,
      liquidation_px: 150,
      leverage_type: "cross",
      leverage_value: 2,
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "90",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "10",
          oid: 2,
          tid: 2002,
          dir: "Close Short",
        },
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-2",
    });

    const discovered = await syncHyperliquidHedgeTrades(baseConfig);

    expect(discovered).toBe(2);
    const events = listHedgeEvents();
    expect(events).toHaveLength(2);

    const closed = events.find((event) => event.status === "closed");
    const open = events.find((event) => event.status === "open");

    expect(closed).toMatchObject({
      trade_key: "trade:fill:HYPE:2002",
      hl_fill_hash: "2002",
      tax_key: "tax:manual:keep-stale",
    });
    expect(open).toMatchObject({
      trade_key: "trade:hl:HYPE:3003",
      tax_key: `tax:hl:${baseConfig.wallet}:HYPE:3003`,
      status: "open",
    });
  });

  it("rekeys fallback active rows to fill-derived identity when fill history later appears", async () => {
    const created = insertHedgeEvent({
      token_id: null,
      coin: "HYPE",
      status: "open",
      entry_px: 120,
      size: 2,
      opened_at: "2024-01-03T00:00:00.000Z",
      closed_at: null,
      close_px: null,
      realized_pnl: null,
      funding_earned: null,
      close_reason: null,
      hl_fill_hash: null,
      trade_key: `trade:hl:active:${baseConfig.wallet}:HYPE:2024-01-03T00:00:00.000Z:120:2`,
      tax_key: `tax:hl:active:${baseConfig.wallet}:HYPE:2024-01-03T00:00:00.000Z:120:2`,
      current_szi: "-2",
      mark_px: 121,
      unrealized_pnl: 2,
      liquidation_px: 150,
      leverage_type: "cross",
      leverage_value: 2,
      updated_at: "2024-01-03T00:00:00.000Z",
    });
    assignHedgeEvent(created.id, "token-123");

    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-2",
    });

    await syncHyperliquidHedgeTrades(baseConfig);

    const reloaded = getHedgeEvent(created.id);
    expect(reloaded).toMatchObject({
      token_id: "token-123",
      trade_key: "trade:hl:HYPE:3003",
      tax_key: `tax:hl:${baseConfig.wallet}:HYPE:3003`,
      status: "open",
    });
    expect(listHedgeEvents()).toHaveLength(1);
  });

  it("preserves an existing manual token assignment across repeated discovery syncs", async () => {
    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "120",
          sz: "2",
          side: "A",
          time: Date.parse("2024-01-03T00:00:00.000Z"),
          closedPnl: "0",
          oid: 3,
          tid: 3003,
          dir: "Open Short",
        },
      ],
      activeSzi: "-2",
    });

    await syncHyperliquidHedgeTrades(baseConfig);

    const created = listHedgeEvents()[0];
    expect(created).toBeDefined();
    assignHedgeEvent(created!.id, "token-123");

    await syncHyperliquidHedgeTrades(baseConfig);

    expect(getHedgeEvent(created!.id)).toMatchObject({
      id: created!.id,
      token_id: "token-123",
      trade_key: "trade:hl:HYPE:3003",
      status: "open",
    });
    expect(listHedgeEvents()).toHaveLength(1);
  });

  it("reuses existing close rows by hl_fill_hash instead of conflicting on trade_key", async () => {
    insertHedgeEvent({
      token_id: "token-123",
      coin: "HYPE",
      status: "closed",
      entry_px: 100,
      size: 1,
      opened_at: "2024-01-01T00:00:00.000Z",
      closed_at: "2024-01-02T00:00:00.000Z",
      close_px: 90,
      realized_pnl: 10,
      funding_earned: 0.5,
      close_reason: "manual_close",
      hl_fill_hash: "2002",
      trade_key: "trade:fill:HYPE:2002",
      tax_key: "tax:manual:closed",
      current_szi: null,
      mark_px: null,
      unrealized_pnl: null,
      liquidation_px: null,
      leverage_type: null,
      leverage_value: null,
      updated_at: "2024-01-02T00:00:00.000Z",
    });

    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "90",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "10",
          oid: 2,
          tid: 2002,
          dir: "Close Short",
        },
      ],
    });

    await syncHyperliquidHedgeTrades(baseConfig);

    const events = listHedgeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      trade_key: "trade:fill:HYPE:2002",
      tax_key: "tax:manual:closed",
      hl_fill_hash: "2002",
    });
  });

  it("ignores malformed and non-HYPE fills without creating hedge events", async () => {
    setFetchMock(async (_input: FetchInput, init?: FetchInit) => {
      const requestType = getRequestType(init);
      if (requestType === "userFillsByTime") {
        return jsonResponse([
          {
            coin: "HYPE",
            px: "100",
            sz: "1",
            side: "A",
            time: "not-a-number",
            closedPnl: "0",
            oid: 1,
            tid: 1001,
            dir: "Open Short",
          },
          {
            coin: "ETH",
            px: "2500",
            sz: "1",
            side: "A",
            time: Date.parse("2024-01-01T00:00:00.000Z"),
            closedPnl: "0",
            oid: 2,
            tid: 2002,
            dir: "Open Short",
          },
        ]);
      }
      if (requestType === "clearinghouseState") {
        return jsonResponse({
          assetPositions: [
            {
              position: {
                coin: "ETH",
                szi: "-1",
                entryPx: "2500",
                positionValue: "2500",
                unrealizedPnl: "0",
                cumFunding: { sinceOpen: "0" },
                leverage: { type: "cross", value: 2 },
                liquidationPx: "3000",
                markPx: "2550",
              },
              type: "perp",
            },
          ],
        });
      }
      throw new Error(`unexpected request type: ${requestType}`);
    });

    const discovered = await syncHyperliquidHedgeTrades(baseConfig);

    expect(discovered).toBe(0);
    expect(listHedgeEvents()).toEqual([]);
  });

  it("reuses legacy closed rows identified by hl_fill_hash instead of duplicating them", async () => {
    insertHedgeEvent({
      token_id: "token-123",
      coin: "HYPE",
      status: "closed",
      entry_px: 100,
      size: 1,
      opened_at: "2024-01-01T00:00:00.000Z",
      closed_at: "2024-01-02T00:00:00.000Z",
      close_px: 90,
      realized_pnl: 10,
      funding_earned: 0.5,
      close_reason: "manual_close",
      hl_fill_hash: "2002",
      trade_key: "trade:legacy:token-123:HYPE:2024-01-01T00:00:00.000Z:100:1",
      tax_key: "tax:manual:closed",
      current_szi: null,
      mark_px: null,
      unrealized_pnl: null,
      liquidation_px: null,
      leverage_type: null,
      leverage_value: null,
      updated_at: "2024-01-02T00:00:00.000Z",
    });

    mockHyperliquidResponses({
      fills: [
        {
          coin: "HYPE",
          px: "100",
          sz: "1",
          side: "A",
          time: Date.parse("2024-01-01T00:00:00.000Z"),
          closedPnl: "0",
          oid: 1,
          tid: 1001,
          dir: "Open Short",
        },
        {
          coin: "HYPE",
          px: "90",
          sz: "1",
          side: "B",
          time: Date.parse("2024-01-02T00:00:00.000Z"),
          closedPnl: "10",
          oid: 2,
          tid: 2002,
          dir: "Close Short",
        },
      ],
    });

    await syncHyperliquidHedgeTrades(baseConfig);

    const events = listHedgeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      token_id: "token-123",
      trade_key: "trade:fill:HYPE:2002",
      tax_key: "tax:manual:closed",
      hl_fill_hash: "2002",
    });
  });
});
