import {
  formatNumber,
  formatPrice,
  formatPercent,
  formatUsd,
  buildNetHedgePnL,
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
      const { lpPnlUsd, hedgePnlUsd, combinedPnlUsd, combinedRoiPct } = buildNetHedgePnL(
        pos,
        hedge,
      );

      // lpPnl: USD if available, else token1-denominated (same as absolutePnl but relabeled)
      if (lpPnlUsd != null) {
        lpPnl = `${formatUsd(lpPnlUsd)} (${formatPercent(pos.absolutePnlPercent)})`;
      }

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
      if (combinedPnlUsd != null && combinedRoiPct != null) {
        netPnl = `${formatUsd(combinedPnlUsd)} (${formatPercent(combinedRoiPct)})`;
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
