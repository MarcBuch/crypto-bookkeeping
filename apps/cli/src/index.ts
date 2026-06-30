import {
  loadConfig,
  // Services
  getPositionsView,
  getPnLView,
  getILView,
  getHedgeView,
  takeSnapshot,
  getHistoryView,
  syncTaxTransactions,
  listTaxTransactions,
  getTaxTransaction,
  updateTaxTransaction,
  createManualTaxTransaction,
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
  type ManualTaxTransactionInput,
  type HedgeView,
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
  if (
    raw === "Trade" ||
    raw === "Transfer" ||
    raw === "Approval" ||
    raw === "Repay Loan" ||
    raw === "unlabeled"
  ) {
    return raw;
  }
  throw new Error("label must be Trade, Transfer, Approval, Repay Loan, or unlabeled");
}

function parseUpdateTaxLabel(raw: string): TaxTransactionLabel {
  if (raw === "Trade" || raw === "Transfer" || raw === "Approval" || raw === "Repay Loan") {
    return raw;
  }
  if (raw === "null" || raw === "clear" || raw === "none" || raw === "unlabeled") return null;
  throw new Error(
    "label must be Trade, Transfer, Approval, Repay Loan, null, clear, none, or unlabeled",
  );
}

function formatTaxTransaction(transaction: StoredTaxTransaction): string {
  const label = transaction.label ?? "unlabeled";
  const timestamp = transaction.time_stamp ?? "unknown time";
  const incoming = formatTaxAmount(transaction.incoming_quantity, transaction.incoming_asset);
  const outgoing = formatTaxAmount(transaction.outgoing_quantity, transaction.outgoing_asset);
  const fee = formatTaxFee(transaction);
  const cost = formatTaxValue(transaction.cost_eur);
  const proceeds = formatTaxValue(transaction.proceeds_eur);
  const gain = formatTaxValue(transaction.gain_eur);
  const holdingDays = formatTaxValue(transaction.holding_duration_days);
  const note = transaction.comment ?? "-";
  return [
    transaction.id,
    label,
    timestamp,
    `in ${incoming}`,
    `out ${outgoing}`,
    `fee ${fee}`,
    `cost EUR ${cost}`,
    `proceeds EUR ${proceeds}`,
    `gain EUR ${gain}`,
    `holding days ${holdingDays}`,
    `note ${note}`,
  ].join(" | ");
}

function formatTaxAmount(quantity: string | null, asset: string | null): string {
  if (!quantity && !asset) return "-";
  return `${quantity ?? "-"} ${asset ?? "?"}`;
}

function formatTaxFee(transaction: StoredTaxTransaction): string {
  if (!transaction.fee) return "-";
  return `${formatTaxBaseUnitAmount(transaction.fee, 18)} HYPE`;
}

function formatTaxBaseUnitAmount(value: string, decimals: number): string {
  try {
    const parsed = BigInt(value);
    const divisor = 10n ** BigInt(decimals);
    const whole = parsed / divisor;
    const remainder = parsed % divisor;
    const decimal = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole.toString()}${decimal ? `.${decimal}` : ""}`;
  } catch {
    return value;
  }
}

function formatTaxValue(value: string | number | null): string {
  if (value === null || value === "") return "-";
  return String(value);
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

    let positions;
    try {
      positions = await getPositionsView(config);
    } catch (err) {
      printCommandError(err instanceof Error ? err.message : "Failed to fetch positions");
      return;
    }

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

    // Fetch hedge views for positions that have hedge config — best-effort
    const hedgeMap = new Map<string, HedgeView>();
    for (const pos of pnlData) {
      if (!config.positions?.[pos.tokenId]?.hedge) continue;
      try {
        hedgeMap.set(pos.tokenId, await getHedgeView(config, pos.tokenId));
      } catch {
        // Hedge fetch failures are non-fatal — LP P&L still displays
      }
    }

    const displayData = formatPnLDisplayData(pnlData, hedgeMap);

    output(formatPnLJsonPayload(pnlData, hedgeMap), () => displayPnL(displayData));
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

    let results;
    try {
      results = await takeSnapshot(config);
    } catch (err) {
      printCommandError(err instanceof Error ? err.message : "Snapshot failed");
      return;
    }

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
const tax = program.command("tax").description("Sync, inspect, add, and label tax transactions");

tax
  .command("add")
  .description("Add a manual tax transaction")
  .option("--id <id>", "Manual transaction ID")
  .option("--hash <hash>", "Transaction hash or manual reference")
  .option("--time <iso>", "Transaction timestamp as an ISO string")
  .option(
    "--label <label>",
    "Trade, Transfer, Approval, Repay Loan, null, clear, none, or unlabeled",
  )
  .option("--comment <comment>", "Comment to store with the transaction")
  .option("--incoming-quantity <quantity>", "Incoming asset quantity")
  .option("--incoming-asset <asset>", "Incoming asset symbol")
  .option("--outgoing-quantity <quantity>", "Outgoing asset quantity")
  .option("--outgoing-asset <asset>", "Outgoing asset symbol")
  .option("--fee <fee>", "Fee amount in base units")
  .option("--cost-eur <amount>", "Cost basis in EUR")
  .option("--proceeds-eur <amount>", "Proceeds in EUR")
  .option("--gain-eur <amount>", "Gain in EUR")
  .option("--holding-days <days>", "Holding duration in days")
  .action(
    (options: {
      id?: string;
      hash?: string;
      time?: string;
      label?: string;
      comment?: string;
      incomingQuantity?: string;
      incomingAsset?: string;
      outgoingQuantity?: string;
      outgoingAsset?: string;
      fee?: string;
      costEur?: string;
      proceedsEur?: string;
      gainEur?: string;
      holdingDays?: string;
    }) => {
      const transaction: ManualTaxTransactionInput = {};
      try {
        if (options.id !== undefined) transaction.id = options.id;
        if (options.hash !== undefined) transaction.hash = options.hash;
        if (options.time !== undefined) transaction.time_stamp = options.time;
        if (options.label !== undefined) transaction.label = parseUpdateTaxLabel(options.label);
        if (options.comment !== undefined) transaction.comment = options.comment;
        if (options.incomingQuantity !== undefined) {
          transaction.incoming_quantity = options.incomingQuantity;
        }
        if (options.incomingAsset !== undefined) transaction.incoming_asset = options.incomingAsset;
        if (options.outgoingQuantity !== undefined) {
          transaction.outgoing_quantity = options.outgoingQuantity;
        }
        if (options.outgoingAsset !== undefined) transaction.outgoing_asset = options.outgoingAsset;
        if (options.fee !== undefined) transaction.fee = options.fee;
        if (options.costEur !== undefined) transaction.cost_eur = options.costEur;
        if (options.proceedsEur !== undefined) transaction.proceeds_eur = options.proceedsEur;
        if (options.gainEur !== undefined) transaction.gain_eur = options.gainEur;
        if (options.holdingDays !== undefined) {
          transaction.holding_duration_days = parseNonNegativeInteger(
            options.holdingDays,
            "holding-days",
          );
        }
        if (Object.keys(transaction).length === 0) {
          throw new Error("tax add requires at least one manual field");
        }

        const created = createManualTaxTransaction(transaction);
        output({ transaction: created }, () => {
          console.log(`Added tax transaction ${created.id}.`);
          console.log(formatTaxTransaction(created));
        });
      } catch (err) {
        printCommandError(err instanceof Error ? err.message : "Invalid tax add options");
      }
    },
  );

tax
  .command("sync")
  .description("Sync tax transactions for the configured wallet")
  .action(async () => {
    const config = loadConfig();

    if (!isJsonMode()) console.log(`Syncing tax transactions for ${config.wallet}...`);

    try {
      const sync = await syncTaxTransactions(config);

      output({ sync }, () => {
        console.log(
          `Synced ${sync.synced} tax transaction(s) from ${sync.source} for ${sync.wallet}.`,
        );
        if (sync.hedgeFlowsSynced != null && sync.hedgeFlowsSynced > 0) {
          console.log(`  of which ${sync.hedgeFlowsSynced} hedge flow(s).`);
        }
        if (sync.latestBlockNumber !== null) {
          console.log(`Latest block: ${sync.latestBlockNumber}`);
        }
      });
    } catch (err) {
      printCommandError(err instanceof Error ? err.message : "Tax sync failed");
    }
  });

tax
  .command("list")
  .description("List stored tax transactions")
  .option("--limit <number>", "Number of transactions to show", "50")
  .option("--offset <number>", "Number of transactions to skip", "0")
  .option("--label <label>", "Filter by Trade, Transfer, Approval, Repay Loan, or unlabeled")
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
  .option(
    "--label <label>",
    "Trade, Transfer, Approval, Repay Loan, null, clear, none, or unlabeled",
  )
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
