import type { Config } from "../config.js";
import {
  insertHedgeSnapshot,
  getOpenHedgeEvent,
  getEarliestHedgeSnapshot,
  insertHedgeEvent,
  listHedgeSnapshots,
  closeHedgeEvent,
  getHedgeEvents,
  type StoredHedgeEvent,
  type StoredHedgeSnapshot,
} from "../db/store.js";
import { isRecord } from "../utils/guards.js";
import type { PnLView } from "./pnl.js";

export interface HedgeView {
  tokenId: string;
  coin: string;
  szi: string; // e.g. "-30.1"
  entryPx: number;
  markPx: number;
  unrealizedPnl: number;
  fundingEarned: number; // cumFunding.sinceOpen, positive when short earns
  liquidationPx: number | null;
  leverage: { type: string; value: number };
  status: "active" | "closed";
  realizedPnl?: number | null;
  closedAt?: string | null;
  closeReason?: string | null;
  stale?: boolean;
}

class HyperliquidApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HyperliquidApiError";
  }
}

const STALE_LEVERAGE = { type: "cross", value: 0 };

interface HyperliquidPosition {
  position: {
    coin: string;
    szi: string;
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    cumFunding?: {
      sinceOpen?: string;
    };
    leverage: { type: string; value: number };
    liquidationPx: string;
    markPx: string;
  };
  type: string;
}

interface HyperliquidFill {
  coin: string;
  px: string;
  sz: string;
  side: "A" | "B";
  time: number;
  closedPnl: string;
  oid: number;
  tid: number;
  dir: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postHyperliquid(
  config: Config,
  payload: Record<string, unknown>,
  context: string,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    throw new HyperliquidApiError(
      `Hyperliquid API request failed when ${context} for wallet ${config.wallet}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new HyperliquidApiError(
      `Hyperliquid API error (${response.status}): ${response.statusText} ` +
        `when ${context} for wallet ${config.wallet}`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new HyperliquidApiError(
      `Hyperliquid API returned invalid JSON when ${context} for wallet ${config.wallet}: ${errorMessage(error)}`,
    );
  }
}

function buildStaleHedgeView(
  tokenId: string,
  coin: string,
  snapshot: StoredHedgeSnapshot,
): HedgeView {
  const closedEvent = getHedgeEvents(tokenId).find(
    (event) => event.coin === coin && event.status === "closed",
  );
  const isClosed = parseFloat(snapshot.szi) === 0 || closedEvent != null;

  if (isClosed) {
    return {
      tokenId,
      coin,
      szi: snapshot.szi,
      entryPx: closedEvent?.entry_px ?? snapshot.entry_px,
      markPx: closedEvent?.close_px ?? snapshot.mark_px,
      unrealizedPnl: 0,
      fundingEarned: closedEvent?.funding_earned ?? snapshot.funding_earned,
      liquidationPx: snapshot.liquidation_px,
      leverage: STALE_LEVERAGE,
      status: "closed",
      realizedPnl: closedEvent?.realized_pnl ?? null,
      closedAt: closedEvent?.closed_at ?? null,
      closeReason: closedEvent?.close_reason ?? null,
      stale: true,
    };
  }

  return {
    tokenId,
    coin,
    szi: snapshot.szi,
    entryPx: snapshot.entry_px,
    markPx: snapshot.mark_px,
    unrealizedPnl: snapshot.unrealized_pnl,
    fundingEarned: snapshot.funding_earned,
    liquidationPx: snapshot.liquidation_px,
    leverage: STALE_LEVERAGE,
    status: "active",
    stale: true,
  };
}

function buildKnownClosedStaleHedgeView(
  tokenId: string,
  coin: string,
  position: HyperliquidPosition,
  snapshot: StoredHedgeSnapshot | null,
): HedgeView {
  const closedEvent = getHedgeEvents(tokenId).find(
    (event) => event.coin === coin && event.status === "closed",
  );

  return {
    tokenId,
    coin,
    szi: position.position.szi,
    entryPx: parseFloat(position.position.entryPx),
    markPx: closedEvent?.close_px ?? parseFloat(position.position.markPx),
    unrealizedPnl: 0,
    fundingEarned: closedEvent?.funding_earned ?? snapshot?.funding_earned ?? 0,
    liquidationPx: null,
    leverage: position.position.leverage,
    status: "closed",
    realizedPnl: closedEvent?.realized_pnl ?? null,
    closedAt: closedEvent?.closed_at ?? null,
    closeReason: closedEvent?.close_reason ?? null,
    stale: true,
  };
}

function getLatestHedgeSnapshot(tokenId: string, coin: string): StoredHedgeSnapshot | null {
  return listHedgeSnapshots(tokenId).find((snapshot) => snapshot.coin === coin) ?? null;
}

export async function getHedgeView(config: Config, tokenId: string): Promise<HedgeView> {
  // Read hedge config for this position
  const hedgeConfig = config.positions?.[tokenId]?.hedge;
  if (!hedgeConfig) {
    throw new Error(
      `Position #${tokenId} does not have a hedge configuration. ` +
        `Add "hedge": { "coin": "HYPE" } to config.positions[${tokenId}]`,
    );
  }

  const coin = hedgeConfig.coin;

  try {
    const data = await postHyperliquid(
      config,
      {
        type: "clearinghouseState",
        user: config.wallet,
      },
      "fetching clearinghouse state",
    );

    const assetPositions =
      isRecord(data) && Array.isArray(data.assetPositions)
        ? data.assetPositions.filter(isHyperliquidPosition)
        : null;

    // Guard against missing assetPositions
    if (!assetPositions) {
      throw new HyperliquidApiError(
        `Hyperliquid API response missing assetPositions for wallet ${config.wallet}. ` +
          `Response structure may have changed.`,
      );
    }

    // Find the position matching the configured coin
    const position = assetPositions.find((ap) => ap.position.coin === coin);

    if (!position) {
      // Position is fully absent from Hyperliquid (settled and removed, not just szi=0).
      // Attempt to reconstruct a closed view from fills + local data.
      const closedView = await resolveAbsentPosition(config, tokenId, coin);
      if (closedView) return closedView;

      throw new Error(
        `No open ${coin} position found on Hyperliquid for wallet ${config.wallet}. ` +
          `Available positions: ${assetPositions.map((ap) => ap.position.coin).join(", ") || "none"}`,
      );
    }

    // Check if position is closed (szi === 0)
    const szi = parseFloat(position.position.szi);
    if (szi === 0) {
      // Position closed on Hyperliquid — detect and record the close
      let closedEvent: StoredHedgeEvent | null;
      try {
        closedEvent = await resolveHedgeClose(config, tokenId, coin);
      } catch (error) {
        if (error instanceof HyperliquidApiError) {
          return buildKnownClosedStaleHedgeView(
            tokenId,
            coin,
            position,
            getLatestHedgeSnapshot(tokenId, coin),
          );
        }

        throw error;
      }

      return {
        tokenId,
        coin,
        szi: position.position.szi,
        entryPx: parseFloat(position.position.entryPx),
        markPx: parseFloat(position.position.markPx),
        unrealizedPnl: 0,
        fundingEarned: closedEvent?.funding_earned ?? 0,
        liquidationPx: null,
        leverage: position.position.leverage,
        status: "closed",
        realizedPnl: closedEvent?.realized_pnl ?? null,
        closedAt: closedEvent?.closed_at ?? null,
        closeReason: closedEvent?.close_reason ?? null,
      };
    }

    // Parse all numeric fields
    const entryPx = parseFloat(position.position.entryPx);
    const markPx = parseFloat(position.position.markPx);
    const unrealizedPnl = parseFloat(position.position.unrealizedPnl);
    const fundingEarned = parseFloat(position.position.cumFunding?.sinceOpen ?? "0");
    const liquidationPx = parseFloat(position.position.liquidationPx);

    return {
      tokenId,
      coin,
      szi: position.position.szi,
      entryPx,
      markPx,
      unrealizedPnl,
      fundingEarned,
      liquidationPx: isNaN(liquidationPx) ? null : liquidationPx,
      leverage: position.position.leverage,
      status: "active",
    };
  } catch (error) {
    if (error instanceof HyperliquidApiError) {
      const snapshot = getLatestHedgeSnapshot(tokenId, coin);
      if (snapshot) {
        return buildStaleHedgeView(tokenId, coin, snapshot);
      }
    }

    throw error;
  }
}

export function snapshotHedge(view: HedgeView): void {
  if (view.stale) {
    return;
  }

  insertHedgeSnapshot({
    token_id: view.tokenId,
    coin: view.coin,
    szi: view.szi,
    entry_px: view.entryPx,
    mark_px: view.markPx,
    unrealized_pnl: view.unrealizedPnl,
    funding_earned: view.fundingEarned,
    liquidation_px: view.liquidationPx,
  });
}

/**
 * Infer the close reason from the set of closing fills.
 *
 * Hyperliquid encodes direction in the `dir` field, e.g.:
 *   "Close Short" — voluntary close (TP/manual)
 *   "Close Long"  — voluntary close
 *   "Liquidated"  — liquidation (may appear on its own or alongside Close)
 *
 * Rules:
 *   - Any fill whose dir contains "Liquidat" → "liquidation"
 *   - All fills are closing fills and none mention liquidation → "manual_close"
 *   - Fallback (unknown dir format) → "manual_close"
 */
function inferCloseReason(closingFills: HyperliquidFill[]): "liquidation" | "manual_close" {
  if (closingFills.some((f) => f.dir.toLowerCase().includes("liquidat"))) {
    return "liquidation";
  }
  return "manual_close";
}

/**
 * Compute the volume-weighted average price (VWAP) across a set of fills.
 * Falls back to the price of the single largest fill when total size is zero
 * (should not happen in practice).
 */
function vwapClose(fills: HyperliquidFill[]): number {
  const totalSize = fills.reduce((s, f) => s + parseFloat(f.sz), 0);
  if (totalSize === 0) {
    const largest = fills.reduce((m, f) => (parseFloat(f.sz) > parseFloat(m.sz) ? f : m));
    return parseFloat(largest.px);
  }
  const weightedSum = fills.reduce((s, f) => s + parseFloat(f.px) * parseFloat(f.sz), 0);
  return weightedSum / totalSize;
}

/**
 * Handles the case where a position is completely absent from Hyperliquid's
 * clearinghouseState (fully settled, removed) and no local snapshots exist.
 *
 * Strategy:
 * 1. Check if we already have a closed hedge_event (idempotent fast-path).
 * 2. Fetch all fills for this coin since epoch 0 — opening fills give us
 *    entry price and size; closing fills give us realized P&L.
 * 3. If no fills found at all, return null (genuinely no history).
 */
async function resolveAbsentPosition(
  config: Config,
  tokenId: string,
  coin: string,
): Promise<HedgeView | null> {
  // Fast path: already recorded in DB
  const existingClosed = getHedgeEvents(tokenId).find(
    (e) => e.coin === coin && e.status === "closed",
  );
  if (existingClosed) {
    return buildClosedView(tokenId, coin, existingClosed);
  }

  // Fetch all fills for this wallet (no startTime filter — no local open event to anchor to)
  const fillsJson = await postHyperliquid(
    config,
    {
      type: "userFillsByTime",
      user: config.wallet,
      startTime: 0,
    },
    "fetching fills for absent hedge resolution",
  );
  const fills = Array.isArray(fillsJson) ? fillsJson.filter(isHyperliquidFill) : [];
  const coinFills = fills.filter((f) => f.coin === coin);
  if (coinFills.length === 0) return null;

  // Derive entry from the earliest open fill
  const openFills = coinFills.filter((f) => f.dir.includes("Open"));
  const closingFills = coinFills.filter((f) => f.dir.includes("Close"));
  if (closingFills.length === 0) return null;

  const entryPx =
    openFills.length > 0 ? parseFloat(openFills.reduce((e, f) => (f.time < e.time ? f : e)).px) : 0;

  const totalClosedPnl = closingFills.reduce((s, f) => s + parseFloat(f.closedPnl), 0);
  const closePx = vwapClose(closingFills);
  const largestFill = closingFills.reduce((m, f) => (parseFloat(f.sz) > parseFloat(m.sz) ? f : m));
  const totalSize =
    openFills.length > 0
      ? openFills.reduce((s, f) => s + parseFloat(f.sz), 0)
      : closingFills.reduce((s, f) => s + parseFloat(f.sz), 0);

  // Write the open event (bootstrap) then close it
  const openedAt =
    openFills.length > 0
      ? new Date(Math.min(...openFills.map((f) => f.time))).toISOString()
      : new Date(Math.min(...closingFills.map((f) => f.time))).toISOString();

  // Insert open event (idempotent — partial unique index guards duplicates)
  try {
    insertHedgeEvent({
      token_id: tokenId,
      coin,
      status: "open",
      entry_px: entryPx,
      size: totalSize,
      opened_at: openedAt,
      closed_at: null,
      close_px: null,
      realized_pnl: null,
      funding_earned: null,
      close_reason: null,
      hl_fill_hash: null,
    });
  } catch {
    // Race or already exists — continue
  }

  const closedEvent = closeHedgeEvent({
    token_id: tokenId,
    coin,
    closed_at: new Date(largestFill.time).toISOString(),
    close_px: closePx,
    realized_pnl: totalClosedPnl,
    // funding_earned is unknown here — no snapshots available. Store null so
    // callers can distinguish "zero" from "not recorded".
    funding_earned: null,
    close_reason: inferCloseReason(closingFills),
    hl_fill_hash: String(largestFill.tid),
  });

  const finalEvent =
    closedEvent ??
    getHedgeEvents(tokenId).find((e) => e.coin === coin && e.status === "closed") ??
    null;

  return finalEvent ? buildClosedView(tokenId, coin, finalEvent) : null;
}

function buildClosedView(tokenId: string, coin: string, event: StoredHedgeEvent): HedgeView {
  return {
    tokenId,
    coin,
    szi: "0",
    entryPx: event.entry_px,
    markPx: event.close_px ?? 0,
    unrealizedPnl: 0,
    fundingEarned: event.funding_earned ?? 0,
    liquidationPx: null,
    leverage: { type: "cross", value: 0 },
    status: "closed",
    realizedPnl: event.realized_pnl,
    closedAt: event.closed_at,
    closeReason: event.close_reason,
  };
}

export function resolveHedgeOpen(tokenId: string, coin: string): StoredHedgeEvent | null {
  // Check if an open event already exists (idempotent)
  const existingOpen = getOpenHedgeEvent(tokenId, coin);
  if (existingOpen) {
    return existingOpen;
  }

  // Query the earliest hedge_snapshot for this (tokenId, coin)
  const earliestSnapshot = getEarliestHedgeSnapshot(tokenId, coin);
  if (!earliestSnapshot) {
    return null;
  }

  // Create the open event from the earliest snapshot
  try {
    return insertHedgeEvent({
      token_id: tokenId,
      coin: coin,
      status: "open",
      entry_px: earliestSnapshot.entry_px,
      size: Math.abs(parseFloat(earliestSnapshot.szi)),
      opened_at: earliestSnapshot.snapshot_at,
      closed_at: null,
      close_px: null,
      realized_pnl: null,
      funding_earned: null,
      close_reason: null,
      hl_fill_hash: null,
    });
  } catch {
    // Race: another caller already inserted the open event — return it
    return getOpenHedgeEvent(tokenId, coin);
  }
}

export async function resolveHedgeClose(
  config: Config,
  tokenId: string,
  coin: string,
): Promise<StoredHedgeEvent | null> {
  // Step 1: Check if already closed (idempotent)
  const allEvents = getHedgeEvents(tokenId);
  const existingClosed = allEvents.find(
    (event) => event.status === "closed" && event.coin === coin,
  );
  if (existingClosed) {
    return existingClosed;
  }

  // Step 2: Ensure we have an open event
  const openEvent = resolveHedgeOpen(tokenId, coin);
  if (!openEvent) {
    return null;
  }

  // Step 3: Get funding_earned from most recent hedge_snapshots
  const snapshots = listHedgeSnapshots(tokenId);
  const mostRecentSnapshot = snapshots.find((s) => s.coin === coin);
  const fundingEarned = mostRecentSnapshot?.funding_earned ?? 0;

  // Step 4: Fetch fills from Hyperliquid userFillsByTime API
  const fillsJson = await postHyperliquid(
    config,
    {
      type: "userFillsByTime",
      user: config.wallet,
      startTime: new Date(openEvent.opened_at).getTime(),
    },
    "fetching userFillsByTime",
  );
  const fills = Array.isArray(fillsJson) ? fillsJson.filter(isHyperliquidFill) : [];

  // Step 5: Filter fills to find closing fills for this coin.
  // Include both voluntary closes ("Close Short", "Close Long") and
  // liquidations ("Liquidated") — both reduce/clear the position.
  const closingFills = fills.filter(
    (fill) =>
      fill.coin === coin &&
      (fill.dir.includes("Close") || fill.dir.toLowerCase().includes("liquidat")),
  );

  if (closingFills.length === 0) {
    return null;
  }

  // Step 6: Sum up closedPnl across all closing fills
  const totalClosedPnl = closingFills.reduce((sum, fill) => sum + parseFloat(fill.closedPnl), 0);

  // Step 7: VWAP close price across all closing fills; largest fill used for
  // the representative tid (hl_fill_hash) and closed_at timestamp.
  const closePx = vwapClose(closingFills);
  const largestFill = closingFills.reduce((max, fill) =>
    parseFloat(fill.sz) > parseFloat(max.sz) ? fill : max,
  );

  // Step 8: Call closeHedgeEvent
  const closedEvent = closeHedgeEvent({
    token_id: tokenId,
    coin,
    closed_at: new Date(largestFill.time).toISOString(),
    close_px: closePx,
    realized_pnl: totalClosedPnl,
    funding_earned: fundingEarned,
    close_reason: inferCloseReason(closingFills),
    hl_fill_hash: String(largestFill.tid),
  });

  // Step 9: Return the closed event (or re-fetch if race condition)
  if (closedEvent) {
    return closedEvent;
  }

  // Re-fetch in case of race condition
  const allEventsAfter = getHedgeEvents(tokenId);
  return allEventsAfter.find((event) => event.status === "closed" && event.coin === coin) || null;
}

// ---------------------------------------------------------------------------
// Shared net hedge P&L helper
// ---------------------------------------------------------------------------

/**
 * The combined LP + hedge P&L figures used in the CLI and web UI.
 *
 * All fields are `null` when the required price data is unavailable (i.e.
 * `token1UsdPrice` is null) or when realized P&L is unknown for a closed
 * hedge.
 */
export interface NetHedgePnL {
  /** LP absolute P&L in USD */
  lpPnlUsd: number | null;
  /**
   * Hedge P&L in USD.
   * - Active: unrealizedPnl + fundingEarned
   * - Closed with known realizedPnl: realizedPnl + fundingEarned
   * - Closed with unknown realizedPnl: null
   */
  hedgePnlUsd: number | null;
  /** LP entry value in USD (used for ROI denominator) */
  lpEntryUsd: number | null;
  /**
   * Combined (LP + hedge) P&L in USD.
   * Null when either leg is null.
   */
  combinedPnlUsd: number | null;
  /**
   * Combined ROI as a decimal fraction (e.g. 0.05 = 5 %).
   * Null when combined P&L or entry value is null, or entry value is zero.
   */
  combinedRoiPct: number | null;
}

/**
 * Compute the combined LP + hedge P&L figures from a `PnLView` and a
 * `HedgeView`. This is the single source of truth shared by the CLI
 * (`pnl-format.ts`) and the web (`App.tsx / HedgePanel`).
 */
export function buildNetHedgePnL(pnl: PnLView, hedge: HedgeView): NetHedgePnL {
  const hedgePnlUsd: number | null =
    hedge.status === "closed"
      ? hedge.realizedPnl != null
        ? hedge.realizedPnl + hedge.fundingEarned
        : null
      : hedge.unrealizedPnl + hedge.fundingEarned;

  const lpPnlUsd: number | null =
    pnl.token1UsdPrice != null ? pnl.absolutePnlInToken1 * pnl.token1UsdPrice : null;

  const lpEntryUsd: number | null =
    pnl.token1UsdPrice != null ? pnl.entryValueInToken1 * pnl.token1UsdPrice : null;

  const combinedPnlUsd = lpPnlUsd != null && hedgePnlUsd != null ? lpPnlUsd + hedgePnlUsd : null;

  const combinedRoiPct =
    combinedPnlUsd != null && lpEntryUsd != null && lpEntryUsd > 0
      ? combinedPnlUsd / lpEntryUsd
      : null;

  return { lpPnlUsd, hedgePnlUsd, lpEntryUsd, combinedPnlUsd, combinedRoiPct };
}

function isHyperliquidPosition(value: unknown): value is HyperliquidPosition {
  return (
    isRecord(value) &&
    isRecord(value.position) &&
    typeof value.position.coin === "string" &&
    typeof value.position.szi === "string" &&
    typeof value.position.entryPx === "string" &&
    typeof value.position.unrealizedPnl === "string" &&
    typeof value.position.liquidationPx === "string" &&
    typeof value.position.markPx === "string" &&
    isRecord(value.position.leverage) &&
    typeof value.position.leverage.type === "string" &&
    typeof value.position.leverage.value === "number"
  );
}

function isHyperliquidFill(value: unknown): value is HyperliquidFill {
  return (
    isRecord(value) &&
    typeof value.coin === "string" &&
    typeof value.px === "string" &&
    typeof value.sz === "string" &&
    (value.side === "A" || value.side === "B") &&
    typeof value.time === "number" &&
    typeof value.closedPnl === "string" &&
    typeof value.oid === "number" &&
    typeof value.tid === "number" &&
    typeof value.dir === "string"
  );
}
