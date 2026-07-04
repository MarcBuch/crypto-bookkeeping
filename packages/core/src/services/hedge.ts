import type { Config } from "../config.js";
import { sqliteHedgeStore } from "../db/hedge-store.js";
import type { StoredHedgeEvent, StoredHedgeSnapshot } from "../db/store.js";
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
const HEDGE_DISCOVERY_COIN = "HYPE";
const INVENTORY_EPSILON = 1e-9;

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

interface GroupedHyperliquidLifecycle {
  fills: HyperliquidFill[];
  openingFills: HyperliquidFill[];
  closingFills: HyperliquidFill[];
  netInventory: number;
  maxAbsInventory: number;
}

interface OpenIdentityCandidate {
  tradeKey: string | null;
  taxKey: string | null;
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
  const closedEvent = sqliteHedgeStore.findClosedEvent(tokenId, coin);
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
  const closedEvent = sqliteHedgeStore.findClosedEvent(tokenId, coin);

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
  return sqliteHedgeStore.listSnapshots(tokenId).find((snapshot) => snapshot.coin === coin) ?? null;
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

  sqliteHedgeStore.recordSnapshot({
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

function nearlyZero(value: number): boolean {
  return Math.abs(value) < INVENTORY_EPSILON;
}

function parseFillSignedSize(fill: HyperliquidFill): number {
  const size = parseFloat(fill.sz);
  const dir = fill.dir.toLowerCase();

  if (dir.includes("open short")) return -size;
  if (dir.includes("close short")) return size;
  if (dir.includes("open long")) return size;
  if (dir.includes("close long")) return -size;
  if (fill.side === "B") return size;
  return -size;
}

function sortFillsChronologically(fills: HyperliquidFill[]): HyperliquidFill[] {
  return [...fills].toSorted((a, b) => a.time - b.time || a.tid - b.tid);
}

function vwapFills(fills: HyperliquidFill[]): number {
  if (fills.length === 0) {
    return 0;
  }

  const totalSize = fills.reduce((sum, fill) => sum + parseFloat(fill.sz), 0);
  if (nearlyZero(totalSize)) {
    return parseFloat(fills[0].px);
  }

  const weighted = fills.reduce((sum, fill) => sum + parseFloat(fill.px) * parseFloat(fill.sz), 0);
  return weighted / totalSize;
}

function firstFill(fills: HyperliquidFill[]): HyperliquidFill | null {
  return fills[0] ?? null;
}

function lastFill(fills: HyperliquidFill[]): HyperliquidFill | null {
  return fills.at(-1) ?? null;
}

function largestFill(fills: HyperliquidFill[]): HyperliquidFill | null {
  return fills.reduce<HyperliquidFill | null>(
    (max, fill) => (max == null || parseFloat(fill.sz) > parseFloat(max.sz) ? fill : max),
    null,
  );
}

function isoTime(fill: HyperliquidFill | null, fallback: string): string {
  return fill ? new Date(fill.time).toISOString() : fallback;
}

function splitFillAtZeroCrossing(
  fill: HyperliquidFill,
  closingSize: number,
): [HyperliquidFill, HyperliquidFill] {
  const totalSize = parseFloat(fill.sz);
  const openingSize = Math.max(totalSize - closingSize, 0);

  return [
    {
      ...fill,
      sz: String(closingSize),
    },
    {
      ...fill,
      sz: String(openingSize),
      closedPnl: "0",
    },
  ];
}

function normalizeFillSequence(fills: HyperliquidFill[]): HyperliquidFill[] {
  const normalized: HyperliquidFill[] = [];
  let runningInventory = 0;

  for (const fill of sortFillsChronologically(fills)) {
    const signedSize = parseFillSignedSize(fill);
    const nextInventory = runningInventory + signedSize;

    if (
      !nearlyZero(runningInventory) &&
      Math.sign(runningInventory) !== Math.sign(signedSize) &&
      Math.sign(runningInventory) !== Math.sign(nextInventory) &&
      !nearlyZero(nextInventory)
    ) {
      const closingSize = Math.abs(runningInventory);
      const [closingPart, openingPart] = splitFillAtZeroCrossing(fill, closingSize);
      normalized.push(closingPart, openingPart);
    } else {
      normalized.push(fill);
    }

    runningInventory = nextInventory;
    if (nearlyZero(runningInventory)) {
      runningInventory = 0;
    }
  }

  return normalized;
}

function buildLifecycleTradeKey(params: {
  wallet: string;
  coin: string;
  openedAt: string;
  entryPx: number;
  size: number;
  anchorTid?: number;
  existingTradeKey?: string | null;
}): string {
  if (params.anchorTid != null) {
    return `trade:hl:${params.coin}:${params.anchorTid}`;
  }
  if (params.existingTradeKey) {
    return params.existingTradeKey;
  }
  return `trade:hl:active:${params.wallet}:${params.coin}:${params.openedAt}:${String(params.entryPx)}:${String(params.size)}`;
}

function buildLifecycleTaxKey(params: {
  wallet: string;
  coin: string;
  openedAt: string;
  entryPx: number;
  size: number;
  anchorTid?: number;
  existingTaxKey?: string | null;
}): string {
  if (params.anchorTid != null) {
    return `tax:hl:${params.wallet}:${params.coin}:${params.anchorTid}`;
  }
  if (params.existingTaxKey) {
    return params.existingTaxKey;
  }
  return `tax:hl:active:${params.wallet}:${params.coin}:${params.openedAt}:${String(params.entryPx)}:${String(params.size)}`;
}

function getExistingOpenHedgeEvent(coin: string): StoredHedgeEvent | null {
  return (
    sqliteHedgeStore
      .listAllEvents()
      .find((event) => event.coin === coin && event.status === "open") ?? null
  );
}

function getReusableOpenIdentity(
  existingOpen: StoredHedgeEvent | null,
  anchorTid?: number,
): OpenIdentityCandidate {
  if (!existingOpen) {
    return { tradeKey: null, taxKey: null };
  }

  if (anchorTid == null) {
    return {
      tradeKey: existingOpen.trade_key ?? null,
      taxKey: existingOpen.tax_key ?? null,
    };
  }

  const fillDerivedTradeKey = `trade:hl:${existingOpen.coin}:${anchorTid}`;
  const fillDerivedTaxKeyPrefix = `tax:hl:`;

  return {
    tradeKey: existingOpen.trade_key === fillDerivedTradeKey ? existingOpen.trade_key : null,
    taxKey:
      existingOpen.tax_key != null &&
      existingOpen.tax_key.startsWith(fillDerivedTaxKeyPrefix) &&
      existingOpen.tax_key.endsWith(`:${existingOpen.coin}:${anchorTid}`)
        ? existingOpen.tax_key
        : null,
  };
}

export function groupHyperliquidHedgeFills(fills: HyperliquidFill[]): {
  closedLifecycles: GroupedHyperliquidLifecycle[];
  activeLifecycle: GroupedHyperliquidLifecycle | null;
} {
  const closedLifecycles: GroupedHyperliquidLifecycle[] = [];
  let current: GroupedHyperliquidLifecycle | null = null;

  for (const fill of normalizeFillSequence(fills)) {
    if (current == null || nearlyZero(current.netInventory)) {
      current = {
        fills: [],
        openingFills: [],
        closingFills: [],
        netInventory: 0,
        maxAbsInventory: 0,
      };
    }

    const signedSize = parseFillSignedSize(fill);
    const previousInventory = current.netInventory;
    const nextInventory = previousInventory + signedSize;
    const isOpeningFill =
      nearlyZero(previousInventory) ||
      (Math.sign(previousInventory) === Math.sign(nextInventory) &&
        Math.abs(nextInventory) > Math.abs(previousInventory));

    current.fills.push(fill);
    if (isOpeningFill) {
      current.openingFills.push(fill);
    } else {
      current.closingFills.push(fill);
    }
    current.netInventory = nextInventory;
    current.maxAbsInventory = Math.max(current.maxAbsInventory, Math.abs(nextInventory));

    if (nearlyZero(current.netInventory)) {
      current.netInventory = 0;
      closedLifecycles.push(current);
      current = null;
    }
  }

  return {
    closedLifecycles,
    activeLifecycle: current && !nearlyZero(current.netInventory) ? current : null,
  };
}

function buildClosedDiscoveredEvent(
  config: Config,
  coin: string,
  lifecycle: GroupedHyperliquidLifecycle,
): Omit<StoredHedgeEvent, "id"> & { trade_key: string; tax_key: string } {
  const openingFills = lifecycle.openingFills.length > 0 ? lifecycle.openingFills : lifecycle.fills;
  const closingFills = lifecycle.closingFills.length > 0 ? lifecycle.closingFills : lifecycle.fills;
  const firstOpenFill = firstFill(openingFills) ?? firstFill(lifecycle.fills);
  const representativeCloseFill = largestFill(closingFills) ?? lastFill(lifecycle.fills);
  const openedAt = isoTime(firstOpenFill, new Date().toISOString());
  const entryPx = vwapFills(openingFills);
  const size =
    lifecycle.maxAbsInventory || openingFills.reduce((sum, fill) => sum + parseFloat(fill.sz), 0);
  const closeTid = representativeCloseFill?.tid;

  return {
    token_id: null,
    coin,
    status: "closed",
    entry_px: entryPx,
    size,
    opened_at: openedAt,
    closed_at: isoTime(representativeCloseFill, openedAt),
    close_px: vwapFills(closingFills),
    realized_pnl: closingFills.reduce((sum, fill) => sum + parseFloat(fill.closedPnl), 0),
    funding_earned: null,
    close_reason: inferCloseReason(closingFills),
    hl_fill_hash: closeTid != null ? String(closeTid) : null,
    trade_key:
      closeTid != null ? `trade:fill:${coin}:${closeTid}` : `trade:hl:closed:${coin}:${openedAt}`,
    tax_key:
      closeTid != null
        ? `tax:fill:${coin}:${closeTid}`
        : `tax:hl:closed:${config.wallet}:${coin}:${openedAt}`,
    current_szi: null,
    mark_px: null,
    unrealized_pnl: null,
    liquidation_px: null,
    leverage_type: null,
    leverage_value: null,
    updated_at: isoTime(representativeCloseFill, openedAt),
  };
}

function buildOpenDiscoveredEvent(
  config: Config,
  coin: string,
  position: HyperliquidPosition,
  activeLifecycle: GroupedHyperliquidLifecycle | null,
): Omit<StoredHedgeEvent, "id"> & { trade_key: string; tax_key: string } {
  const existingOpen = getExistingOpenHedgeEvent(coin);
  const firstOpenFill =
    firstFill(activeLifecycle?.openingFills ?? []) ?? firstFill(activeLifecycle?.fills ?? []);
  // Best-effort opened_at: prefer earliest active-lifecycle open fill, then existing store row,
  // then now when Hyperliquid no longer exposes the originating fill.
  const openedAt =
    (firstOpenFill ? new Date(firstOpenFill.time).toISOString() : null) ??
    existingOpen?.opened_at ??
    new Date().toISOString();
  const entryPx = parseFloat(position.position.entryPx);
  const size = Math.abs(parseFloat(position.position.szi));
  const markPx = parseFloat(position.position.markPx);
  const unrealizedPnl = parseFloat(position.position.unrealizedPnl);
  const liquidationPx = parseFloat(position.position.liquidationPx);
  const fundingRaw = position.position.cumFunding?.sinceOpen;
  const fundingEarned = fundingRaw == null ? null : parseFloat(fundingRaw);
  const anchorTid = firstOpenFill?.tid;
  const reusableIdentity = getReusableOpenIdentity(existingOpen, anchorTid);

  return {
    token_id: null,
    coin,
    status: "open",
    entry_px: entryPx,
    size,
    opened_at: openedAt,
    closed_at: null,
    close_px: null,
    realized_pnl: null,
    funding_earned: Number.isFinite(fundingEarned) ? fundingEarned : null,
    close_reason: null,
    hl_fill_hash: null,
    trade_key: buildLifecycleTradeKey({
      wallet: config.wallet,
      coin,
      openedAt,
      entryPx,
      size,
      anchorTid,
      existingTradeKey: reusableIdentity.tradeKey,
    }),
    tax_key: buildLifecycleTaxKey({
      wallet: config.wallet,
      coin,
      openedAt,
      entryPx,
      size,
      anchorTid,
      existingTaxKey: reusableIdentity.taxKey,
    }),
    current_szi: position.position.szi,
    mark_px: Number.isFinite(markPx) ? markPx : null,
    unrealized_pnl: Number.isFinite(unrealizedPnl) ? unrealizedPnl : null,
    liquidation_px: Number.isFinite(liquidationPx) ? liquidationPx : null,
    leverage_type: position.position.leverage.type,
    leverage_value: position.position.leverage.value,
    updated_at: new Date().toISOString(),
  };
}

export async function syncHyperliquidHedgeTrades(
  config: Config,
  coin = HEDGE_DISCOVERY_COIN,
): Promise<number> {
  const fillsJson = await postHyperliquid(
    config,
    {
      type: "userFillsByTime",
      user: config.wallet,
      startTime: 0,
      coin,
    },
    `fetching ${coin} fills for hedge discovery`,
  );

  const fills = Array.isArray(fillsJson)
    ? fillsJson.filter(isHyperliquidFill).filter((fill) => fill.coin === coin)
    : [];
  const { closedLifecycles, activeLifecycle } = groupHyperliquidHedgeFills(fills);

  const clearinghouseState = await postHyperliquid(
    config,
    {
      type: "clearinghouseState",
      user: config.wallet,
    },
    `fetching clearinghouse state for ${coin} hedge discovery`,
  );
  const assetPositions =
    isRecord(clearinghouseState) && Array.isArray(clearinghouseState.assetPositions)
      ? clearinghouseState.assetPositions.filter(isHyperliquidPosition)
      : null;

  if (!assetPositions) {
    throw new HyperliquidApiError(
      `Hyperliquid API response missing assetPositions for wallet ${config.wallet}. Response structure may have changed.`,
    );
  }

  const activePosition = assetPositions.find(
    (assetPosition) => assetPosition.position.coin === coin,
  );

  for (const event of closedLifecycles.map((lifecycle) =>
    buildClosedDiscoveredEvent(config, coin, lifecycle),
  )) {
    sqliteHedgeStore.upsertEventByTradeKey(event);
  }

  let discoveredCount = closedLifecycles.length;

  if (activePosition && !nearlyZero(parseFloat(activePosition.position.szi))) {
    sqliteHedgeStore.upsertEventByTradeKey(
      buildOpenDiscoveredEvent(config, coin, activePosition, activeLifecycle),
    );
    discoveredCount += 1;
  }

  return discoveredCount;
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
  const existingClosed = sqliteHedgeStore.findClosedEvent(tokenId, coin);
  if (existingClosed) {
    return buildClosedView(tokenId, coin, existingClosed);
  }

  await syncHyperliquidHedgeTrades(config, coin);
  const finalEvent = sqliteHedgeStore.findClosedEvent(tokenId, coin) ?? null;

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
  const existingOpen = sqliteHedgeStore.findOpenEvent(tokenId, coin);
  if (existingOpen) {
    return existingOpen;
  }

  // Query the earliest hedge_snapshot for this (tokenId, coin)
  const earliestSnapshot = sqliteHedgeStore.findEarliestSnapshot(tokenId, coin);
  if (!earliestSnapshot) {
    return null;
  }

  // Create the open event from the earliest snapshot
  try {
    return sqliteHedgeStore.recordEvent({
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
    return sqliteHedgeStore.findOpenEvent(tokenId, coin);
  }
}

export async function resolveHedgeClose(
  config: Config,
  tokenId: string,
  coin: string,
): Promise<StoredHedgeEvent | null> {
  // Step 1: Check if already closed (idempotent)
  const existingClosed = sqliteHedgeStore.findClosedEvent(tokenId, coin);
  if (existingClosed) {
    return existingClosed;
  }

  // Step 2: Ensure we have an open event
  const openEvent = resolveHedgeOpen(tokenId, coin);
  if (!openEvent) {
    return null;
  }

  // Step 3: Get funding_earned from most recent hedge_snapshots
  const snapshots = sqliteHedgeStore.listSnapshots(tokenId);
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
  const closingLargestFill = closingFills.reduce((max, fill) =>
    parseFloat(fill.sz) > parseFloat(max.sz) ? fill : max,
  );

  // Step 8: Call closeHedgeEvent
  const closedEvent = sqliteHedgeStore.closeOpenEvent({
    token_id: tokenId,
    coin,
    closed_at: new Date(closingLargestFill.time).toISOString(),
    close_px: closePx,
    realized_pnl: totalClosedPnl,
    funding_earned: fundingEarned,
    close_reason: inferCloseReason(closingFills),
    hl_fill_hash: String(closingLargestFill.tid),
  });

  // Step 9: Return the closed event (or re-fetch if race condition)
  if (closedEvent) {
    return closedEvent;
  }

  // Re-fetch in case of race condition
  return sqliteHedgeStore.findClosedEvent(tokenId, coin);
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
