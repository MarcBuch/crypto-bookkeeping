import {
  loadConfig,
  // Services
  getPositionsView,
  getPnLView,
  getILView,
  takeSnapshot,
  getHistoryView,
  syncTaxTransactions,
  listTaxTransactions,
  getTaxTransaction,
  updateTaxTransaction,
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
  type StoredTaxTransaction,
  type TaxTransactionLabel,
  type TaxTransactionLabelFilter,
  type TaxTransactionUpdate,
} from "@lp-tracker/core";
import { Command } from "commander";

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

function parseNonNegativeInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parsePositiveInteger(raw: string, name: string): number {
  const value = parseNonNegativeInteger(raw, name);
  if (value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseListTaxLabel(raw: string | undefined): TaxTransactionLabelFilter | undefined {
  if (raw === undefined) return undefined;
  if (raw === "Trade" || raw === "Transfer" || raw === "unlabeled") return raw;
  throw new Error("label must be Trade, Transfer, or unlabeled");
}

function parseUpdateTaxLabel(raw: string): TaxTransactionLabel {
  if (raw === "Trade" || raw === "Transfer") return raw;
  if (raw === "null" || raw === "clear" || raw === "none" || raw === "unlabeled") return null;
  throw new Error("label must be Trade, Transfer, null, clear, none, or unlabeled");
}

function formatTaxTransaction(transaction: StoredTaxTransaction): string {
  const label = transaction.label ?? "unlabeled";
  const timestamp = transaction.time_stamp ?? "unknown time";
  const direction = `${transaction.from_address ?? "?"} -> ${transaction.to_address ?? "?"}`;
  const value = transaction.value ?? "0";
  const token = transaction.token_symbol ?? transaction.token_name ?? "native";
  const comment = transaction.comment ? ` | ${transaction.comment}` : "";
  return `${transaction.id} | ${label} | ${timestamp} | ${transaction.transaction_type ?? "tx"} | ${value} ${token} | ${direction}${comment}`;
}

function printCommandError(message: string): void {
  process.exitCode = 1;
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + "\n");
  } else {
    console.error(message);
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

// ===== TAX COMMANDS =====
const tax = program.command("tax").description("Sync, inspect, and label tax transactions");

tax
  .command("sync")
  .description("Sync tax transactions for the configured wallet")
  .action(async () => {
    const config = loadConfig();

    if (!isJsonMode()) console.log(`Syncing tax transactions for ${config.wallet}...`);

    const sync = await syncTaxTransactions(config);

    output({ sync }, () => {
      console.log(
        `Synced ${sync.synced} tax transaction(s) from ${sync.source} for ${sync.wallet}.`,
      );
      if (sync.latestBlockNumber !== null) {
        console.log(`Latest block: ${sync.latestBlockNumber}`);
      }
    });
  });

tax
  .command("list")
  .description("List stored tax transactions")
  .option("--limit <number>", "Number of transactions to show", "50")
  .option("--offset <number>", "Number of transactions to skip", "0")
  .option("--label <label>", "Filter by Trade, Transfer, or unlabeled")
  .action((options: { limit: string; offset: string; label?: string }) => {
    let limit: number;
    let offset: number;
    let label: TaxTransactionLabelFilter | undefined;
    try {
      limit = parsePositiveInteger(options.limit, "limit");
      offset = parseNonNegativeInteger(options.offset, "offset");
      label = parseListTaxLabel(options.label);
    } catch (err) {
      printCommandError(err instanceof Error ? err.message : "Invalid tax list options");
      return;
    }

    const transactions: StoredTaxTransaction[] = listTaxTransactions(limit, offset, label);

    output({ transactions }, () => {
      if (transactions.length === 0) {
        console.log("No tax transactions found.");
        return;
      }
      for (const transaction of transactions) {
        console.log(formatTaxTransaction(transaction));
      }
    });
  });

tax
  .command("get")
  .description("Get one stored tax transaction by ID")
  .argument("<id>", "Tax transaction ID")
  .action((id: string) => {
    const transaction = getTaxTransaction(id);
    if (transaction === null) {
      process.exitCode = 1;
      output({ error: "Tax transaction not found", id }, () => {
        console.error(`Tax transaction not found: ${id}`);
      });
      return;
    }

    output({ transaction }, () => console.log(formatTaxTransaction(transaction)));
  });

tax
  .command("label")
  .description("Update a tax transaction label and/or comment")
  .argument("<id>", "Tax transaction ID")
  .option("--label <label>", "Trade, Transfer, null, clear, none, or unlabeled")
  .option("--comment <comment>", "Comment to store with the transaction")
  .action((id: string, options: { label?: string; comment?: string }) => {
    const update: TaxTransactionUpdate = {};
    try {
      if (options.label !== undefined) {
        update.label = parseUpdateTaxLabel(options.label);
      }
      if (options.comment !== undefined) {
        update.comment = options.comment;
      }
      if (!Object.hasOwn(update, "label") && !Object.hasOwn(update, "comment")) {
        throw new Error("tax label requires --label and/or --comment");
      }
    } catch (err) {
      printCommandError(err instanceof Error ? err.message : "Invalid tax label options");
      return;
    }

    const transaction = updateTaxTransaction(id, update);
    if (transaction === null) {
      process.exitCode = 1;
      output({ error: "Tax transaction not found", id }, () => {
        console.error(`Tax transaction not found: ${id}`);
      });
      return;
    }

    output({ transaction }, () => {
      console.log(`Updated tax transaction ${transaction.id}.`);
      console.log(formatTaxTransaction(transaction));
    });
  });

program.parse();
