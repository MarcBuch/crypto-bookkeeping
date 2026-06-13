import type { PnLView, HedgeView } from "./api";

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

export function buildNetHedgePnL(
  pnl: PnLView | undefined,
  hedge: HedgeView,
): NetHedgePnL {
  const hedgePnlUsd: number | null =
    hedge.status === "closed"
      ? hedge.realizedPnl != null
        ? hedge.realizedPnl + hedge.fundingEarned
        : null
      : hedge.unrealizedPnl + hedge.fundingEarned;

  const lpPnlUsd: number | null =
    pnl?.token1UsdPrice != null
      ? pnl.absolutePnlInToken1 * pnl.token1UsdPrice
      : null;

  const lpEntryUsd: number | null =
    pnl?.token1UsdPrice != null
      ? pnl.entryValueInToken1 * pnl.token1UsdPrice
      : null;

  const combinedPnlUsd =
    lpPnlUsd != null && hedgePnlUsd != null ? lpPnlUsd + hedgePnlUsd : null;

  const combinedRoiPct =
    combinedPnlUsd != null && lpEntryUsd != null && lpEntryUsd > 0
      ? combinedPnlUsd / lpEntryUsd
      : null;

  return { lpPnlUsd, hedgePnlUsd, lpEntryUsd, combinedPnlUsd, combinedRoiPct };
}
