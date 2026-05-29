import { Command } from "commander";
import {
  loadConfig,
  // Services
  getPositionsView,
  getPnLView,
  getILView,
  takeSnapshot,
  getHistoryView,
  NotFoundError,
  // Display
  displayPositions,
  displayIL,
  displayPnL,
  displayHistory,
  formatNumber,
  formatPrice,
  type PositionDisplayData,
  type ILDisplayData,
  type SnapshotDisplayData,
} from "@lp-tracker/core";
import { formatPnLDisplayData, formatPnLJsonPayload } from "./pnl-format.js";

const program = new Command();

program
  .name("lp-tracker")
  .description(
    "Track ProjectX concentrated liquidity positions on HyperEVM and calculate divergence loss",
  )
  .version("1.0.0")
  .option("--json", "Output results as JSON (for agent/programmatic use)");

/** Check if --json flag is set globally */
function isJsonMode(): boolean {
  return process.argv.includes("--json");
}

/** Output data as JSON or call the display function */
function output(data: any, displayFn: () => void): void {
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    displayFn();
  }
}

// In JSON mode, redirect all console.log/warn to stderr so stdout is clean JSON
if (isJsonMode()) {
  console.log = (...args: any[]) => console.error(...args);
  console.warn = (...args: any[]) => console.error(...args);
}

// ===== POSITIONS COMMAND =====
program
  .command("positions")
  .description("List all LP positions for the configured wallet (active and closed)")
  .action(async () => {
    const config = loadConfig();

    if (!isJsonMode()) console.log(`Fetching positions for ${config.wallet}...`);

    const positions = await getPositionsView(config);

    if (positions.length === 0) {
      output({ positions: [] }, () => console.log("No LP positions found for this wallet."));
      return;
    }

    const displayData: PositionDisplayData[] = positions.map((pos) => ({
      tokenId: pos.tokenId,
      pair: `${pos.token0.symbol}/${pos.token1.symbol}`,
      fee: `${pos.feePercent}%`,
      tickRange: `${pos.tickLower} / ${pos.tickUpper}`,
      priceRange: `${formatPrice(pos.priceLower)} - ${formatPrice(pos.priceUpper)}`,
      liquidity: pos.liquidity,
      currentAmounts:
        pos.status === "active"
          ? `${formatNumber(pos.currentAmount0)} ${pos.token0.symbol}\n${formatNumber(pos.currentAmount1)} ${pos.token1.symbol}`
          : "0 (closed)",
      inRange: pos.inRange,
      status: pos.status,
    }));

    output({ positions }, () => displayPositions(displayData));
  });

// ===== PNL COMMAND =====
program
  .command("pnl")
  .description("Show full P&L analysis (absolute gains, divergence loss, opportunity cost)")
  .argument("[tokenId]", "Specific position token ID (optional, shows all if omitted)")
  .action(async (tokenId?: string) => {
    const config = loadConfig();

    if (!isJsonMode()) console.log(`Calculating P&L...`);

    let pnlData;
    try {
      pnlData = await getPnLView(config, tokenId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        console.log(err.message);
        return;
      }
      throw err;
    }

    if (pnlData.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    const displayData = formatPnLDisplayData(pnlData);

    output(formatPnLJsonPayload(pnlData), () => displayPnL(displayData));
  });

// ===== IL COMMAND =====
program
  .command("il")
  .description("Calculate current divergence loss for positions")
  .argument("[tokenId]", "Specific position token ID (optional, shows all if omitted)")
  .action(async (tokenId?: string) => {
    const config = loadConfig();

    if (!isJsonMode()) console.log(`Calculating divergence loss...`);

    let ilData;
    try {
      ilData = await getILView(config, tokenId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        console.log(err.message);
        return;
      }
      throw err;
    }

    if (ilData.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    const displayData: ILDisplayData[] = ilData.map((pos) => ({
      tokenId: pos.tokenId,
      pair: pos.pair,
      entryPrice: formatPrice(pos.entryPrice),
      currentPrice: formatPrice(pos.currentPrice),
      priceRange: `${formatPrice(pos.priceLower)} - ${formatPrice(pos.priceUpper)}`,
      divergenceLoss: `${(pos.divergenceLossPercent * 100).toFixed(4)}%`,
      valueLp: `${formatNumber(pos.valueLpInToken1, 4)} ${pos.token1Symbol}`,
      valueHold: `${formatNumber(pos.valueHoldInToken1, 4)} ${pos.token1Symbol}`,
      fees: `${formatNumber(pos.fees0, 4)} ${pos.token0Symbol}\n${formatNumber(pos.fees1, 4)} ${pos.token1Symbol}`,
      netPnl: `${(pos.netVsHodlPercent * 100).toFixed(4)}% (${formatNumber(pos.netVsHodlInToken1, 4)} ${pos.token1Symbol})`,
    }));

    output({ positions: ilData }, () => displayIL(displayData));
  });

// ===== SNAPSHOT COMMAND =====
program
  .command("snapshot")
  .description("Take a snapshot of all active positions and store to database")
  .action(async () => {
    const config = loadConfig();

    console.log(`Taking snapshot for ${config.wallet}...`);

    const results = await takeSnapshot(config);

    if (results.length === 0) {
      console.log("No LP positions found.");
      return;
    }

    let snapshotCount = 0;
    for (const r of results) {
      console.log(`  ${r.message}`);
      if (r.saved) snapshotCount++;
    }

    console.log(`\nDone! ${snapshotCount} snapshot(s) saved.`);
  });

// ===== HISTORY COMMAND =====
program
  .command("history")
  .description("Show historical divergence loss from stored snapshots")
  .argument("<tokenId>", "Position token ID")
  .option("-n, --limit <number>", "Number of snapshots to show", "20")
  .action(async (tokenId: string, options: { limit: string }) => {
    let historyData;
    try {
      historyData = await getHistoryView(tokenId, parseInt(options.limit));
    } catch (err) {
      if (err instanceof NotFoundError) {
        console.log(err.message);
        return;
      }
      throw err;
    }

    if (historyData.length === 0) {
      console.log(`No snapshots found for position #${tokenId}. Run 'snapshot' first.`);
      return;
    }

    const pair = historyData[0].pair;

    const displayData: SnapshotDisplayData[] = historyData.map((snap) => ({
      timestamp: new Date(snap.timestamp).toLocaleString(),
      currentPrice: formatPrice(snap.currentPrice),
      divergenceLoss: `${(snap.divergenceLossPercent * 100).toFixed(4)}%`,
      fees: `${formatNumber(snap.feesValue, 4)} ${pair.split("/")[1]}`,
      netPnl: `${formatNumber(snap.netPnl, 4)} ${pair.split("/")[1]}`,
      valueLp: `${formatNumber(snap.valueLp, 4)} ${pair.split("/")[1]}`,
    }));

    displayHistory(tokenId, pair, displayData);
  });

program.parse();
