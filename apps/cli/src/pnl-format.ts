import {
  formatNumber,
  formatPrice,
  formatPercent,
  type PnLDisplayData,
  type PnLView,
} from "@lp-tracker/core";

export function formatPnLDisplayData(pnlData: PnLView[]): PnLDisplayData[] {
  return pnlData.map((pos) => {
    const usdFees =
      pos.feesValueUsd === null
        ? "USD fees unavailable"
        : `USD fees $${formatNumber(pos.feesValueUsd, 2)}`;

    return {
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
      divergenceLoss: `${pos.divergenceLossPercent} (${formatNumber(pos.exitValueInToken1 - pos.holdValueInToken1, 4)} ${pos.token1Symbol})`,
      opportunityCost: `${formatNumber(pos.opportunityCostInToken1, 4)} ${pos.token1Symbol}`,
    };
  });
}

export function formatPnLJsonPayload(pnlData: PnLView[]): { positions: PnLView[] } {
  return { positions: pnlData };
}
