import type { HedgeEvent, HedgeView, PnLView } from "./api";

/**
 * The combined LP + hedge P&L figures used in ActivePositionRow and HedgePanel.
 *
 * Mirrors packages/core/src/services/hedge.ts:buildNetHedgePnL — kept in sync
 * manually because the web app does not import from @lp-tracker/core at runtime.
 * If the logic here diverges, update both files together.
 */
export interface NetHedgePnL {
  lpPnlUsd: number | null;
  hedgePnlUsd: number | null;
  lpEntryUsd: number | null;
  combinedPnlUsd: number | null;
  combinedRoiPct: number | null;
}

export interface AssignedActiveHedgeNetPnL extends NetHedgePnL {
  activeCount: number;
  closedCount: number;
  fundingPartial: boolean;
  missingUnrealized: boolean;
}

export interface ClosedAssignedHedgePnlSummary {
  totalUsd: number | null;
  fundingUnknown: boolean;
  count: number;
}

function buildCombinedNetHedgePnL(
  pnl: PnLView | undefined,
  hedgePnlUsd: number | null,
): NetHedgePnL {
  const token1Usd = pnl ? tokenUsdPrice(pnl.token1Symbol, pnl.token1UsdPrice) : null;
  const lpPnlUsd: number | null = token1Usd != null ? pnl!.absolutePnlInToken1 * token1Usd : null;

  const lpEntryUsd: number | null = token1Usd != null ? pnl!.entryValueInToken1 * token1Usd : null;

  const combinedPnlUsd = lpPnlUsd != null && hedgePnlUsd != null ? lpPnlUsd + hedgePnlUsd : null;

  const combinedRoiPct =
    combinedPnlUsd != null && lpEntryUsd != null && lpEntryUsd > 0
      ? combinedPnlUsd / lpEntryUsd
      : null;

  return { lpPnlUsd, hedgePnlUsd, lpEntryUsd, combinedPnlUsd, combinedRoiPct };
}

function tokenUsdPrice(symbol: string, price: number | null | undefined): number | null {
  if (typeof price === "number" && Number.isFinite(price)) {
    return price;
  }

  return /^(?:USDC|USDT|USDE|DAI)$/i.test(symbol) ? 1 : null;
}

export function buildNetHedgePnL(pnl: PnLView | undefined, hedge: HedgeView): NetHedgePnL {
  const hedgePnlUsd: number | null =
    hedge.status === "closed"
      ? hedge.realizedPnl != null
        ? hedge.realizedPnl + hedge.fundingEarned
        : null
      : hedge.unrealizedPnl + hedge.fundingEarned;

  return buildCombinedNetHedgePnL(pnl, hedgePnlUsd);
}

function closedHedgeDedupeKey(hedge: HedgeEvent): string {
  return [
    hedge.coin,
    hedge.opened_at,
    hedge.closed_at ?? "",
    hedge.entry_px,
    hedge.size,
    hedge.close_px ?? "",
    hedge.realized_pnl ?? "",
  ].join("|");
}

export function dedupeClosedAssignedHedges(hedges: HedgeEvent[]): HedgeEvent[] {
  const seen = new Set<string>();
  const deduped: HedgeEvent[] = [];

  for (const hedge of hedges) {
    if (hedge.status !== "closed") continue;
    const key = closedHedgeDedupeKey(hedge);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hedge);
  }

  return deduped;
}

export function sumClosedAssignedHedgePnl(hedges: HedgeEvent[]): ClosedAssignedHedgePnlSummary {
  const closedHedges = dedupeClosedAssignedHedges(hedges);
  if (closedHedges.length === 0) {
    return { totalUsd: null, fundingUnknown: false, count: 0 };
  }

  return closedHedges.reduce<ClosedAssignedHedgePnlSummary>(
    (acc, hedge) => {
      acc.totalUsd = (acc.totalUsd ?? 0) + (hedge.realized_pnl ?? 0);
      if (hedge.funding_earned != null) {
        acc.totalUsd += hedge.funding_earned;
      } else {
        acc.fundingUnknown = true;
      }
      acc.count += 1;
      return acc;
    },
    { totalUsd: 0, fundingUnknown: false, count: 0 },
  );
}

export function buildNetHedgePnLFromEvents(
  pnl: PnLView | undefined,
  hedges: HedgeEvent[],
): AssignedActiveHedgeNetPnL {
  const closedHedges = sumClosedAssignedHedgePnl(hedges);
  const activeHedges = hedges.filter((hedge) => hedge.status === "open");

  if (activeHedges.length === 0 && closedHedges.count === 0) {
    return {
      ...buildCombinedNetHedgePnL(pnl, null),
      activeCount: 0,
      closedCount: 0,
      fundingPartial: false,
      missingUnrealized: false,
    };
  }

  let openHedgePnlUsd = 0;
  let fundingPartial = closedHedges.fundingUnknown;
  let missingUnrealized = false;

  for (const hedge of activeHedges) {
    if (hedge.unrealized_pnl == null) {
      missingUnrealized = true;
      continue;
    }

    openHedgePnlUsd += hedge.unrealized_pnl;
    if (hedge.funding_earned != null) {
      openHedgePnlUsd += hedge.funding_earned;
    } else {
      fundingPartial = true;
    }
  }

  const hedgePnlUsd = (closedHedges.totalUsd ?? 0) + openHedgePnlUsd;

  return {
    ...buildCombinedNetHedgePnL(pnl, hedgePnlUsd),
    activeCount: activeHedges.length,
    closedCount: closedHedges.count,
    fundingPartial,
    missingUnrealized,
  };
}
