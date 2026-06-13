import {
  formatNumber,
  formatPrice,
  formatPercent,
  formatUsd,
  type PnLDisplayData,
  type PnLView,
  type HedgeView,
} from "@lp-tracker/core";

export function formatPnLDisplayData(
  pnlData: PnLView[],
  hedgeMap: Map<string, HedgeView> = new Map(),
): PnLDisplayData[] {
  return pnlData.map((pos) => {
    const usdFees =
      pos.feesValueUsd === null
        ? "USD fees unavailable"
        : `USD fees $${formatNumber(pos.feesValueUsd, 2)}`;

    const baseFields = {
      tokenId: pos.tokenId,
      pair: pos.pair,
      status: pos.status === "active" ? "ACTIVE" : "CLOSED",
      entryPrice: `${formatPrice(pos.entryPrice)} ${pos.token1Symbol}/${pos.token0Symbol}`,
      exitPrice: `${formatPrice(pos.exitPrice)} ${pos.token1Symbol}/${pos.token0Symbol} (${formatPercent((pos.exitPrice - pos.entryPrice) / pos.entryPrice)})`,
      deposited: `${formatNumber(pos.entryAmount0, 4)} ${pos.token0Symbol} + ${formatNumber(pos.entryAmount1, 4)} ${pos.token1Symbol}`,
      withdrawn: `${formatNumber(pos.exitAmount0, 4)} ${pos.token0Symbol} + ${formatNumber(pos.exitAmount1, 4)} ${pos.token1Symbol}`,
      entryValue: `${formatNumber(pos.entryValueInToken1, 4)} ${pos.token1Symbol}`,
      exitValue: `${formatNumber(pos.exitValueInToken1, 4)} ${pos.token1Symbol}`,
      holdValue: `${formatNumber(pos.holdValueInToken1, 4)} ${pos.token1Symbol}`,
      feesEarned: `${formatNumber(pos.feesCollected0, 4)} ${pos.token0Symbol} + ${formatNumber(pos.feesCollected1, 4)} ${pos.token1Symbol} (= ${formatNumber(pos.feesValueInToken1, 4)} ${pos.token1Symbol}; ${usdFees})`,
      absolutePnl: `${formatNumber(pos.absolutePnlInToken1, 4)} ${pos.token1Symbol} (${formatPercent(pos.absolutePnlPercent)})`,
      divergenceLoss: `${formatPercent(pos.divergenceLossPercent)} (${formatNumber(pos.exitValueInToken1 - pos.holdValueInToken1, 4)} ${pos.token1Symbol})`,
      opportunityCost: `${formatNumber(pos.opportunityCostInToken1, 4)} ${pos.token1Symbol}`,
    };

    // Hedge-adjusted fields (only when hedge is configured for this position)
    const hedge = hedgeMap.get(pos.tokenId);
    let lpPnl: string | undefined;
    let hedgePnl: string | undefined;
    let netPnl: string | undefined;

    if (hedge) {
      // hedge P&L in USD (Hyperliquid always returns USD)
      const hedgePnlUsd: number | null =
        hedge.status === "closed"
          ? hedge.realizedPnl != null
            ? hedge.realizedPnl + hedge.fundingEarned
            : null
          : hedge.unrealizedPnl + hedge.fundingEarned;

      // LP P&L in USD (only if token1UsdPrice available)
      const lpAbsPnlUsd: number | null =
        pos.token1UsdPrice != null
          ? pos.absolutePnlInToken1 * pos.token1UsdPrice
          : null;

      const lpEntryUsd: number | null =
        pos.token1UsdPrice != null
          ? pos.entryValueInToken1 * pos.token1UsdPrice
          : null;

      // lpPnl: USD if available, else token1-denominated (same as absolutePnl but relabeled)
      if (lpAbsPnlUsd != null) {
        lpPnl = `${formatUsd(lpAbsPnlUsd)} (${formatPercent(pos.absolutePnlPercent)})`;
      }
      // else lpPnl stays undefined → displayPnL falls back to absolutePnl

      // hedgePnl string — always USD
      if (hedge.status === "closed") {
        if (hedge.realizedPnl != null) {
          hedgePnl = `${formatUsd(hedgePnlUsd!)}  (realized ${formatUsd(hedge.realizedPnl)} + funding ${formatUsd(hedge.fundingEarned)})`;
        } else {
          hedgePnl = `realized P&L unknown + funding ${formatUsd(hedge.fundingEarned)}`;
        }
      } else {
        hedgePnl = `${formatUsd(hedgePnlUsd!)}  (unrealized ${formatUsd(hedge.unrealizedPnl)} + funding ${formatUsd(hedge.fundingEarned)})`;
      }

      // netPnl — only when both sides in USD and entry > 0
      if (lpAbsPnlUsd != null && hedgePnlUsd != null && lpEntryUsd != null && lpEntryUsd > 0) {
        const combinedUsd = lpAbsPnlUsd + hedgePnlUsd;
        const combinedRoiPct = combinedUsd / lpEntryUsd;
        netPnl = `${formatUsd(combinedUsd)} (${formatPercent(combinedRoiPct)})`;
      }
    }

    return {
      ...baseFields,
      ...(lpPnl !== undefined ? { lpPnl } : {}),
      ...(hedgePnl !== undefined ? { hedgePnl } : {}),
      ...(netPnl !== undefined ? { netPnl } : {}),
    };
  });
}

export function formatPnLJsonPayload(
  pnlData: PnLView[],
  hedgeMap: Map<string, HedgeView> = new Map(),
): { positions: Array<PnLView & { hedge?: HedgeView }> } {
  return {
    positions: pnlData.map((pos) => {
      const hedge = hedgeMap.get(pos.tokenId);
      return hedge ? { ...pos, hedge } : pos;
    }),
  };
}
