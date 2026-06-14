import Table from "cli-table3";

export interface PositionDisplayData {
  tokenId: string;
  pair: string;
  fee: string;
  tickRange: string;
  priceRange: string;
  liquidity: string;
  currentAmounts: string;
  inRange: boolean;
  status: "active" | "closed";
}

export interface ILDisplayData {
  tokenId: string;
  pair: string;
  entryPrice: string;
  currentPrice: string;
  priceRange: string;
  divergenceLoss: string;
  valueLp: string;
  valueHold: string;
  fees: string;
  netPnl: string;
}

export interface PnLDisplayData {
  tokenId: string;
  pair: string;
  status: string;
  entryPrice: string;
  exitPrice: string;
  deposited: string;
  withdrawn: string;
  entryValue: string;
  exitValue: string;
  holdValue: string;
  feesEarned: string;
  absolutePnl: string;
  divergenceLoss: string;
  opportunityCost: string;
  /** LP P&L formatted string — replaces absolutePnl row label when hedge is present */
  lpPnl?: string;
  /** Hedge P&L formatted string — always USD; present only when hedge data available */
  hedgePnl?: string;
  /** Net P&L (LP + hedge) — present only when both USD figures available */
  netPnl?: string;
}

export interface SnapshotDisplayData {
  timestamp: string;
  currentPrice: string;
  divergenceLoss: string;
  fees: string;
  netPnl: string;
  valueLp: string;
}

export function displayPositions(positions: PositionDisplayData[]): void {
  const table = new Table({
    head: [
      "Token ID",
      "Pair",
      "Fee",
      "Status",
      "Price Range",
      "Liquidity",
      "Current Amounts",
      "In Range",
    ],
    style: { head: ["cyan"] },
    wordWrap: true,
  });

  for (const pos of positions) {
    table.push([
      pos.tokenId,
      pos.pair,
      pos.fee,
      pos.status === "active" ? "ACTIVE" : "CLOSED",
      pos.priceRange,
      pos.liquidity,
      pos.currentAmounts,
      pos.status === "closed" ? "-" : pos.inRange ? "YES" : "NO",
    ]);
  }

  console.log("\n=== ProjectX LP Positions (HyperEVM) ===\n");
  console.log(table.toString());
}

export function displayIL(positions: ILDisplayData[]): void {
  const table = new Table({
    head: [
      "Token ID",
      "Pair",
      "Entry Price",
      "Current Price",
      "Price Range",
      "DL %",
      "LP Value",
      "HODL Value",
      "Fees Earned",
      "Net P&L",
    ],
    style: { head: ["cyan"] },
    wordWrap: true,
  });

  for (const pos of positions) {
    table.push([
      pos.tokenId,
      pos.pair,
      pos.entryPrice,
      pos.currentPrice,
      pos.priceRange,
      pos.divergenceLoss,
      pos.valueLp,
      pos.valueHold,
      pos.fees,
      pos.netPnl,
    ]);
  }

  console.log("\n=== Divergence Loss (Impermanent Loss) ===\n");
  console.log(table.toString());
  console.log("\nDL% = (LP Value - HODL Value) / HODL Value. Negative = loss vs holding.");
  console.log("Net P&L = DL + Fees Earned (denominated in token1)\n");
}

export function displayPnL(positions: PnLDisplayData[]): void {
  for (const pos of positions) {
    const table = new Table({
      style: { head: ["cyan"] },
    });

    table.push(
      [
        {
          colSpan: 2,
          content: `Position #${pos.tokenId} (${pos.pair}) - ${pos.status}`,
          hAlign: "center",
        },
      ],
      ["Entry Price", pos.entryPrice],
      ["Exit/Current Price", pos.exitPrice],
      ["Price Change", pos.exitPrice],
      ["", ""],
      [{ colSpan: 2, content: "--- Amounts ---", hAlign: "center" }],
      ["Deposited", pos.deposited],
      ["Withdrawn/Current", pos.withdrawn],
      ["Fees Earned", pos.feesEarned],
      ["", ""],
      [{ colSpan: 2, content: "--- P&L Analysis ---", hAlign: "center" }],
      ["Entry Value", pos.entryValue],
      ["LP Value (excl. fees)", pos.exitValue],
      ["LP Value + Fees", pos.exitValue + " + " + pos.feesEarned],
      ["HODL Value", pos.holdValue],
      ["", ""],
      [{ colSpan: 2, content: "--- Results ---", hAlign: "center" }],
      ["LP P&L (fees vs entry)", pos.lpPnl ?? pos.absolutePnl],
      ...(pos.hedgePnl ? [["Hedge P&L", pos.hedgePnl]] : []),
      ...(pos.netPnl ? [["Net P&L (LP + hedge)", pos.netPnl]] : []),
      ["Divergence Loss (LP vs HODL)", pos.divergenceLoss],
      ["Opportunity Cost vs HODL", pos.opportunityCost],
    );

    console.log("\n" + table.toString());
  }

  console.log("\n--- Legend ---");
  console.log("LP P&L          = What you actually gained/lost vs your deposit (LP fees included)");
  console.log(
    "Hedge P&L       = Unrealized P&L + funding earned (active) or realized P&L + funding (closed)",
  );
  console.log("Net P&L         = LP P&L + hedge P&L (shown only when both are in USD)");
  console.log("Divergence Loss = Money left on the table vs simply holding");
  console.log("Opportunity Cost= HODL value - LP value (how much more HODL would have earned)\n");
}

export function displayHistory(
  tokenId: string,
  pair: string,
  snapshots: SnapshotDisplayData[],
): void {
  const table = new Table({
    head: ["Timestamp", "Price", "DL %", "Fees", "Net P&L", "LP Value"],
    style: { head: ["cyan"] },
  });

  for (const snap of snapshots) {
    table.push([
      snap.timestamp,
      snap.currentPrice,
      snap.divergenceLoss,
      snap.fees,
      snap.netPnl,
      snap.valueLp,
    ]);
  }

  console.log(`\n=== History for Position #${tokenId} (${pair}) ===\n`);
  console.log(table.toString());
}

export function formatNumber(n: number, decimals = 6): string {
  if (Math.abs(n) < 0.000001) return "0";
  if (Math.abs(n) > 1_000_000) {
    return n.toLocaleString("en-US", {
      maximumFractionDigits: 2,
    });
  }
  return n.toFixed(decimals);
}

export function formatPrice(n: number): string {
  if (n === 0) return "0";
  if (n > 1000) return n.toFixed(2);
  if (n > 1) return n.toFixed(4);
  if (n > 0.001) return n.toFixed(6);
  return n.toExponential(4);
}

export function formatUsd(n: number): string {
  if (Math.abs(n) < 0.01) return "$0.00";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(2)}%`;
}
